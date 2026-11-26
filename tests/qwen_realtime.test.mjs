// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  create_realtime_asr_client,
  check_realtime_availability,
  resolve_realtime_url,
  resample_pcm16,
  upsample_16k_to_24k,
  DEFAULT_REALTIME_CONNECT_TIMEOUT_MS,
  REALTIME_SAMPLE_RATE,
  SOURCE_SAMPLE_RATE
} from '../server/lib/qwen_realtime.mjs';

/** Standard `WebSocket.readyState` values, named the same way
 *  qwen_realtime.mjs itself avoids sprinkling them as magic numbers. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** A stubbed WebSocket implementing exactly the surface
 *  `create_realtime_asr_client` uses (`addEventListener`, `send`,
 *  `close`, `readyState`) — the real Node global `WebSocket` (undici)
 *  implements this same DOM-shaped API, so exercising the client against
 *  this stub is exercising the real integration seam, no network involved
 *  (per the handover's "no network in tests"). Test code drives the
 *  simulated server side via `_open()`/`_message()`/`_error()`/
 *  `_serverClose()`. */
class StubSocket {
  constructor(url) {
    this.url = url;
    this.readyState = CONNECTING;
    this.sent = [];
    this._listeners = { open: [], message: [], error: [], close: [] };
  }
  addEventListener(type, cb) {
    this._listeners[type].push(cb);
  }
  send(data) {
    if (this.readyState !== OPEN) throw new Error('send() on a non-open socket');
    this.sent.push(data);
  }
  close() {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this._emit('close', { code: 1000 });
  }
  _emit(type, ev) {
    for (const cb of this._listeners[type]) cb(ev);
  }
  _open() {
    this.readyState = OPEN;
    this._emit('open', {});
  }
  _message(payload) {
    this._emit('message', { data: JSON.stringify(payload) });
  }
  _error() {
    this._emit('error', {});
  }
  /** Simulates the proxy's own post-commit behavior: an abrupt server-
   *  side close, no clean handshake — code 1006, matching what the real
   *  proxy does (see qwen_realtime.mjs's module header). */
  _serverClose(code = 1006) {
    this.readyState = CLOSED;
    this._emit('close', { code });
  }
}

/** Factory that hands back both the `WebSocketImpl` to inject and a way
 *  to reach the single instance it constructs (`create_realtime_asr_client`
 *  only ever opens one socket per client). */
function stub_ws_factory() {
  let instance;
  function WebSocketImpl(url) {
    instance = new StubSocket(url);
    return instance;
  }
  return { WebSocketImpl, get instance() { return instance; } };
}

describe('resolve_realtime_url', () => {
  it('defaults to ws://127.0.0.1:8001/v1/realtime with no env override', () => {
    expect(resolve_realtime_url({})).toBe('ws://127.0.0.1:8001/v1/realtime');
  });
  it('honors ASR_REALTIME_URL, trimmed', () => {
    expect(resolve_realtime_url({ ASR_REALTIME_URL: '  ws://127.0.0.1:9001/v1/realtime  ' })).toBe('ws://127.0.0.1:9001/v1/realtime');
  });
  it('ignores an empty/whitespace-only override', () => {
    expect(resolve_realtime_url({ ASR_REALTIME_URL: '   ' })).toBe('ws://127.0.0.1:8001/v1/realtime');
  });
});

describe('resample_pcm16', () => {
  it('returns the same reference when rates already match', () => {
    const buf = Buffer.from([1, 0, 2, 0]);
    expect(resample_pcm16(buf, 16000, 16000)).toBe(buf);
  });
  it('returns pcmBytes unchanged for a non-finite/non-positive rate rather than throwing', () => {
    const buf = Buffer.from([1, 0]);
    expect(resample_pcm16(buf, 0, 24000)).toBe(buf);
    expect(resample_pcm16(buf, 16000, -1)).toBe(buf);
    expect(resample_pcm16(buf, NaN, 24000)).toBe(buf);
  });
  it('returns an empty buffer for empty input', () => {
    const out = resample_pcm16(Buffer.alloc(0), 16000, 24000);
    expect(out.length).toBe(0);
  });
  it('upsampling 16k->24k grows sample count by the 1.5x ratio', () => {
    const inSamples = 1000;
    const buf = Buffer.alloc(inSamples * 2);
    for (let i = 0; i < inSamples; i++) buf.writeInt16LE(0, i * 2);
    const out = resample_pcm16(buf, 16000, 24000);
    expect(out.length / 2).toBe(1500);
  });
  it('linearly interpolates between two known sample values', () => {
    // Two samples (0, 1000), doubling the rate (8k->16k, ratio 0.5) so
    // outSamples = floor(2 / 0.5) = 4, at srcIndex 0, 0.5, 1.0, 1.5.
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(1000, 2);
    const out = resample_pcm16(buf, 8000, 16000);
    expect(out.length / 2).toBe(4);
    expect(out.readInt16LE(0)).toBe(0); // srcIndex 0   -> exactly sample 0
    expect(out.readInt16LE(2)).toBe(500); // srcIndex 0.5 -> halfway between 0 and 1000
    expect(out.readInt16LE(4)).toBe(1000); // srcIndex 1.0 -> exactly sample 1
    expect(out.readInt16LE(6)).toBe(1000); // srcIndex 1.5 -> clamped at the last sample
  });
});

describe('upsample_16k_to_24k', () => {
  it('is resample_pcm16 fixed at the codebase source rate and the proxy target rate', () => {
    const buf = Buffer.alloc(SOURCE_SAMPLE_RATE * 2); // 1s of 16kHz silence
    const out = upsample_16k_to_24k(buf);
    expect(out.length / 2).toBe(REALTIME_SAMPLE_RATE); // 1s of 24kHz
  });
});

describe('create_realtime_asr_client: connect()', () => {
  it('stays pending until the socket actually opens (no premature resolution)', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    const connectPromise = client.connect();
    const raced = await Promise.race([connectPromise, new Promise((r) => setTimeout(() => r('pending'), 50))]);
    expect(raced).toBe('pending');
    client.close();
  });

  it('resolves true once open() fires on the client-owned socket', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    const connectPromise = client.connect();
    factory.instance._open();
    expect(await connectPromise).toBe(true);
    client.close();
  });

  it('resolves false on a connect timeout when the socket never opens', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl, connectTimeoutMs: 20 });
    const startedAt = Date.now();
    const result = await client.connect();
    expect(result).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it('resolves false promptly (not waiting out the full timeout) when the socket errors before opening — the "endpoint absent" case', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl, connectTimeoutMs: DEFAULT_REALTIME_CONNECT_TIMEOUT_MS });
    const startedAt = Date.now();
    const connectPromise = client.connect();
    factory.instance._error();
    factory.instance._serverClose();
    const result = await connectPromise;
    expect(result).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it('resolves false rather than throwing when the WebSocketImpl constructor itself throws (malformed url)', async () => {
    function ThrowingWebSocketImpl() {
      throw new TypeError('invalid url');
    }
    const client = create_realtime_asr_client({ WebSocketImpl: ThrowingWebSocketImpl });
    expect(await client.connect()).toBe(false);
  });

  it('resolves false with no WebSocketImpl available at all (e.g. an old Node runtime)', async () => {
    // `false`, not `undefined`: `create_realtime_asr_client` falls back to
    // the global `WebSocket` on an OMITTED option (nullish coalescing), so
    // this codebase's actual Node 22+ runtime would otherwise mask the
    // "no WebSocket global exists" branch this test means to exercise —
    // a falsy-but-not-nullish sentinel is the only way to force it from
    // here without changing the option's own semantics.
    const client = create_realtime_asr_client({ WebSocketImpl: false });
    expect(await client.connect()).toBe(false);
  });
});

describe('create_realtime_asr_client: partial transcripts mid-stream', () => {
  it('calls onCompleted for a completed event that arrives WITHOUT the socket closing (the 28s auto-chunk case)', async () => {
    const factory = stub_ws_factory();
    const completed = [];
    const disconnects = [];
    const client = create_realtime_asr_client({
      WebSocketImpl: factory.WebSocketImpl,
      onCompleted: (e) => completed.push(e),
      onDisconnect: (e) => disconnects.push(e)
    });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;

    factory.instance._message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_001',
      transcript: 'hallo welt'
    });

    expect(completed).toEqual([{ itemId: 'item_001', transcript: 'hallo welt' }]);
    expect(disconnects).toHaveLength(0); // socket is still open — not a disconnect

    client.close();
  });

  it('ignores a malformed (non-JSON) message frame rather than throwing', async () => {
    const factory = stub_ws_factory();
    const completed = [];
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl, onCompleted: (e) => completed.push(e) });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;

    expect(() => factory.instance._emit('message', { data: 'not json{' })).not.toThrow();
    expect(completed).toHaveLength(0);

    client.close();
  });

  it('silently accepts an unrecognized message type', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;
    expect(() => factory.instance._message({ type: 'session.updated' })).not.toThrow();
    client.close();
  });
});

describe('create_realtime_asr_client: commit() -> final transcript -> expected close', () => {
  it('commit() sends the commit frame; committed + completed + an abrupt server close all fire, with onDisconnect({expected: true})', async () => {
    const factory = stub_ws_factory();
    const committed = [];
    const completed = [];
    const disconnects = [];
    const client = create_realtime_asr_client({
      WebSocketImpl: factory.WebSocketImpl,
      onCommitted: (e) => committed.push(e),
      onCompleted: (e) => completed.push(e),
      onDisconnect: (e) => disconnects.push(e)
    });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;

    client.commit();
    expect(factory.instance.sent).toHaveLength(1);
    expect(JSON.parse(factory.instance.sent[0])).toEqual({ type: 'input_audio_buffer.commit' });

    factory.instance._message({ type: 'input_audio_buffer.committed', item_id: 'item_002' });
    factory.instance._message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_002',
      transcript: 'the tail text'
    });
    // The proxy's own behavior: it replies then closes the raw connection
    // unilaterally, no clean handshake (module header, point 2).
    factory.instance._serverClose(1006);

    expect(committed).toEqual([{ itemId: 'item_002' }]);
    expect(completed).toEqual([{ itemId: 'item_002', transcript: 'the tail text' }]);
    expect(disconnects).toEqual([{ expected: true }]);
  });
});

describe('create_realtime_asr_client: disconnect mid-stream (no commit)', () => {
  it('reports onDisconnect({expected: false}) when the socket closes without ever committing', async () => {
    const factory = stub_ws_factory();
    const disconnects = [];
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl, onDisconnect: (e) => disconnects.push(e) });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;

    factory.instance._serverClose(1006); // server crash / network drop, not our commit

    expect(disconnects).toEqual([{ expected: false }]);
  });

  it('does NOT report onDisconnect for our own deliberate close()', async () => {
    const factory = stub_ws_factory();
    const disconnects = [];
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl, onDisconnect: (e) => disconnects.push(e) });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;

    client.close(); // fires the stub's own close event synchronously

    expect(disconnects).toHaveLength(0);
  });

  it('reports onDisconnect only once even if error and close both fire', async () => {
    const factory = stub_ws_factory();
    const disconnects = [];
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl, onDisconnect: (e) => disconnects.push(e) });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;

    factory.instance._error();
    factory.instance._serverClose(1006);

    expect(disconnects).toHaveLength(1);
  });
});

describe('create_realtime_asr_client: append()', () => {
  it('resamples 16kHz PCM to 24kHz and sends it base64-encoded as input_audio_buffer.append', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;

    const pcm16k = Buffer.alloc(1600); // 50ms of 16kHz mono PCM16 (silence)
    client.append(pcm16k);

    expect(factory.instance.sent).toHaveLength(1);
    const frame = JSON.parse(factory.instance.sent[0]);
    expect(frame.type).toBe('input_audio_buffer.append');
    const decoded = Buffer.from(frame.audio, 'base64');
    expect(decoded.length).toBe(upsample_16k_to_24k(pcm16k).length);

    client.close();
  });

  it('is a no-op (never throws) when the socket is not open yet', () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    void client.connect(); // socket exists but never opened
    expect(() => client.append(Buffer.alloc(100))).not.toThrow();
    expect(factory.instance.sent).toHaveLength(0);
  });

  it('is a no-op (never throws) after the socket has closed', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;
    client.close();
    expect(() => client.append(Buffer.alloc(100))).not.toThrow();
    expect(factory.instance.sent).toHaveLength(0);
  });
});

describe('create_realtime_asr_client: commit()/close() no-op safety', () => {
  it('commit() before the socket is open is a no-op, never throws', () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    void client.connect();
    expect(() => client.commit()).not.toThrow();
    expect(factory.instance.sent).toHaveLength(0);
  });

  it('close() before connect() ever resolves is safe', () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    void client.connect();
    expect(() => client.close()).not.toThrow();
  });

  it('close() is idempotent', async () => {
    const factory = stub_ws_factory();
    const client = create_realtime_asr_client({ WebSocketImpl: factory.WebSocketImpl });
    const connectPromise = client.connect();
    factory.instance._open();
    await connectPromise;
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});

describe('check_realtime_availability', () => {
  it('resolves true and closes the probe connection when the endpoint accepts it', async () => {
    const factory = stub_ws_factory();
    const promise = check_realtime_availability({ WebSocketImpl: factory.WebSocketImpl });
    factory.instance._open();
    expect(await promise).toBe(true);
    expect(factory.instance.readyState).toBe(CLOSED);
  });

  it('resolves false when the endpoint is absent (connect timeout)', async () => {
    const factory = stub_ws_factory();
    const result = await check_realtime_availability({ WebSocketImpl: factory.WebSocketImpl, connectTimeoutMs: 15 });
    expect(result).toBe(false);
  });
});
