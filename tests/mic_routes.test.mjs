// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { handle_request } from '../server/lib/router.mjs';
import { create_mic_stream_registry } from '../server/lib/whisper_stream.mjs';

/** Same fake req pattern as llm_routes.test.mjs/factcheck_routes.test.mjs. */
function fake_req(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

/** Plain buffering fake_res — for the non-SSE mic routes (start/audio/flush/stop). */
function fake_res() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(chunk) {
      if (chunk) res.body += chunk;
    }
  };
  return res;
}

/** Same EventEmitter-backed fake SSE res as factcheck_routes.test.mjs, for
 *  GET /api/mic/stream/:id — accumulates every `write()`'d event/data
 *  block and supports `res.on('close', ...)`. */
function fake_sse_res() {
  const emitter = new EventEmitter();
  let text = '';
  const res = Object.assign(emitter, {
    statusCode: null,
    headers: null,
    writableEnded: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    write(chunk) {
      text += chunk;
      return true;
    },
    end(chunk) {
      if (chunk) text += chunk;
      res.writableEnded = true;
    }
  });
  Object.defineProperty(res, 'events', {
    get() {
      return text
        .split('\n\n')
        .filter((block) => block.trim())
        .map((block) => {
          const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          return { event: eventLine.slice('event:'.length).trim(), data: JSON.parse(dataLine.slice('data:'.length).trim()) };
        });
    }
  });
  return res;
}

let activeRegistry;
afterEach(() => {
  if (activeRegistry) activeRegistry.stop_all();
  activeRegistry = undefined;
});

function fresh_registry(overrides = {}) {
  activeRegistry = create_mic_stream_registry({ sweepMs: 0, tickMs: 15, whisperRun: async () => 'x', ...overrides });
  return activeRegistry;
}

describe('POST /api/mic/start', () => {
  it('503s with whisper_unavailable when the binary is missing', async () => {
    const req = fake_req('POST', '/api/mic/start');
    const res = fake_res();
    await handle_request(req, res, {
      micRegistry: fresh_registry(),
      whisperAvailabilityCheck: () => ({ available: false, bin: 'whisper-cli', model: '/m.bin', modelPresent: false })
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'whisper_unavailable' });
  });

  it('503s with whisper_unavailable when the binary is found but the model file is missing', async () => {
    const req = fake_req('POST', '/api/mic/start');
    const res = fake_res();
    await handle_request(req, res, {
      micRegistry: fresh_registry(),
      whisperAvailabilityCheck: () => ({ available: true, bin: 'whisper-cli', model: '/m.bin', modelPresent: false })
    });
    expect(res.statusCode).toBe(503);
  });

  it('v0.3: 503s with whisper_unavailable when an ASYNC injected check (asr_engine.mjs shape) resolves unavailable', async () => {
    const req = fake_req('POST', '/api/mic/start');
    const res = fake_res();
    await handle_request(req, res, {
      micRegistry: fresh_registry(),
      whisperAvailabilityCheck: async () => ({ available: false, bin: 'http://127.0.0.1:8001', model: 'qwen3-asr', modelPresent: false, engine: 'none' })
    });
    expect(res.statusCode).toBe(503);
  });

  it('v0.3: 200s from an ASYNC injected check that resolves available+modelPresent', async () => {
    const registry = fresh_registry();
    const req = fake_req('POST', '/api/mic/start');
    const res = fake_res();
    await handle_request(req, res, {
      micRegistry: registry,
      whisperAvailabilityCheck: async () => ({ available: true, bin: 'http://127.0.0.1:8001', model: 'qwen3-asr', modelPresent: true, engine: 'qwen' })
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('200s with a fresh streamId when available and modelPresent are both true, and the registry actually has it', async () => {
    const registry = fresh_registry();
    const req = fake_req('POST', '/api/mic/start');
    const res = fake_res();
    await handle_request(req, res, {
      micRegistry: registry,
      whisperAvailabilityCheck: () => ({ available: true, bin: 'whisper-cli', model: '/m.bin', modelPresent: true })
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.streamId).toBe('string');
    expect(registry.has(body.streamId)).toBe(true);
  });
});

describe('POST /api/mic/audio/:id', () => {
  it('404s for an unknown stream id', async () => {
    const req = fake_req('POST', '/api/mic/audio/nope', Buffer.alloc(10));
    const res = fake_res();
    await handle_request(req, res, { micRegistry: fresh_registry() });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ ok: false });
  });

  it('200s for a known stream id and the audio actually reaches the registry (observed via a subsequent transcription tick)', async () => {
    const registry = fresh_registry({
      whisperRun: async (wav) => `${wav.length - 44} bytes`
    });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));

    const req = fake_req('POST', `/api/mic/audio/${id}`, Buffer.alloc(1600));
    const res = fake_res();
    await handle_request(req, res, { micRegistry: registry });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    await new Promise((resolve) => {
      const check = () => {
        if (events.some((e) => e.text === '1600 bytes')) return resolve();
        setTimeout(check, 5);
      };
      check();
    });
  });
});

describe('POST /api/mic/flush/:id', () => {
  it('404s for an unknown stream id', async () => {
    const req = fake_req('POST', '/api/mic/flush/nope');
    const res = fake_res();
    await handle_request(req, res, { micRegistry: fresh_registry() });
    expect(res.statusCode).toBe(404);
  });

  it('200s for a known id and actually emits a final event to subscribers', async () => {
    const registry = fresh_registry({ whisperRun: async () => 'flushed text' });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));
    registry.append_audio(id, Buffer.alloc(1600));

    const req = fake_req('POST', `/api/mic/flush/${id}`);
    const res = fake_res();
    await handle_request(req, res, { micRegistry: registry });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(events[events.length - 1]).toMatchObject({ final: true, text: 'flushed text' });
  });
});

describe('POST /api/mic/stop/:id', () => {
  it('404s for an unknown stream id', async () => {
    const req = fake_req('POST', '/api/mic/stop/nope');
    const res = fake_res();
    await handle_request(req, res, { micRegistry: fresh_registry() });
    expect(res.statusCode).toBe(404);
  });

  it('200s for a known id and the registry no longer has it afterward', async () => {
    const registry = fresh_registry();
    const id = registry.create();
    const req = fake_req('POST', `/api/mic/stop/${id}`);
    const res = fake_res();
    await handle_request(req, res, { micRegistry: registry });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(registry.has(id)).toBe(false);
  });
});

describe('GET /api/mic/stream/:id', () => {
  it('404s (plain JSON, no SSE headers) for an unknown stream id', async () => {
    const req = fake_req('GET', '/api/mic/stream/nope');
    const res = fake_res();
    await handle_request(req, res, { micRegistry: fresh_registry() });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'not_found' });
  });

  it('streams partial/final events as SSE for a known id, in the order the registry emits them', async () => {
    const registry = fresh_registry({ whisperRun: async () => 'live text' });
    const id = registry.create();

    const req = fake_req('GET', `/api/mic/stream/${id}`);
    const res = fake_sse_res();
    await handle_request(req, res, { micRegistry: registry });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');

    registry.append_audio(id, Buffer.alloc(1600));
    await new Promise((resolve) => {
      const check = () => {
        if (res.events.length >= 1) return resolve();
        setTimeout(check, 5);
      };
      check();
    });
    expect(res.events[0]).toMatchObject({ event: 'partial', data: { final: false, text: 'live text' } });

    await registry.flush(id);
    const finalEvent = res.events[res.events.length - 1];
    expect(finalEvent).toMatchObject({ event: 'final', data: { final: true, text: 'live text' } });
  });

  it('unsubscribes on client disconnect (res close) — later registry events are no longer delivered', async () => {
    const registry = fresh_registry({ whisperRun: async () => 'x' });
    const id = registry.create();

    const req = fake_req('GET', `/api/mic/stream/${id}`);
    const res = fake_sse_res();
    await handle_request(req, res, { micRegistry: registry });

    res.emit('close'); // simulates the client's AbortController.abort()
    const countBeforeMoreAudio = res.events.length;

    registry.append_audio(id, Buffer.alloc(1600));
    await new Promise((r) => setTimeout(r, 60)); // longer than tickMs — give it a chance to have fired

    expect(res.events.length).toBe(countBeforeMoreAudio);
  });

  it('v0.2 fix round 1 (Important 2): res close stops the WHOLE underlying stream, not just this route\'s own subscription — the registry no longer has it, and append_audio afterward fails', async () => {
    const registry = fresh_registry({ whisperRun: async () => 'x' });
    const id = registry.create();

    const req = fake_req('GET', `/api/mic/stream/${id}`);
    const res = fake_sse_res();
    await handle_request(req, res, { micRegistry: registry });
    expect(registry.has(id)).toBe(true);

    res.emit('close');

    expect(registry.has(id)).toBe(false);
    expect(registry.append_audio(id, Buffer.alloc(1600))).toBe(false);
  });

  it('v0.2 fix round 1 (Important 2): the tick loop actually STOPS spawning whisperRun after close, rather than continuing until the stale sweep', async () => {
    let whisperRunCalls = 0;
    const registry = fresh_registry({
      tickMs: 15,
      whisperRun: async () => {
        whisperRunCalls += 1;
        return 'x';
      }
    });
    const id = registry.create();
    registry.append_audio(id, Buffer.alloc(3200)); // buffered BEFORE the stream even opens

    const req = fake_req('GET', `/api/mic/stream/${id}`);
    const res = fake_sse_res();
    await handle_request(req, res, { micRegistry: registry });

    // Let at least one real tick fire so whisperRun has demonstrably
    // started running against this stream.
    await new Promise((resolve) => {
      const check = () => (whisperRunCalls >= 1 ? resolve() : setTimeout(check, 5));
      check();
    });

    res.emit('close');
    const callsAtClose = whisperRunCalls;

    // Feeding more audio post-close is a no-op (append_audio returns false
    // for an unknown/stopped id — covered by the previous test), so this
    // is really asserting the timer itself was cleared: waiting several
    // more tick intervals must not grow the call count at all.
    await new Promise((r) => setTimeout(r, 150)); // ~10x tickMs
    expect(whisperRunCalls).toBe(callsAtClose);
  });
});
