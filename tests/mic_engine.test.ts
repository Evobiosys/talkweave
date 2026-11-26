// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach, vi } from 'vitest';
import { create_mic_engine } from '../app/src/lib/mic_engine';
import type { EngineEvent } from '../shared/engine';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A controllable fake `ReadableStreamDefaultReader<Uint8Array>`: `push`
 *  queues a text chunk, `end` queues the terminal `{done:true}` — both
 *  resolve an already-pending `read()` immediately if one is waiting,
 *  otherwise buffer for the next call. Lets a test build up an SSE body
 *  incrementally without a real `ReadableStream`. */
function make_controlled_reader() {
  const queue: { value?: Uint8Array; done: boolean }[] = [];
  let resolveNext: ((chunk: { value?: Uint8Array; done: boolean }) => void) | null = null;

  function deliver(chunk: { value?: Uint8Array; done: boolean }) {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(chunk);
    } else {
      queue.push(chunk);
    }
  }

  return {
    push(text: string) {
      deliver({ value: new TextEncoder().encode(text), done: false });
    },
    end() {
      deliver({ value: undefined, done: true });
    },
    reader: {
      read(): Promise<{ value?: Uint8Array; done: boolean }> {
        return new Promise((resolve) => {
          if (queue.length > 0) resolve(queue.shift()!);
          else resolveNext = resolve;
        });
      }
    }
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Routes a fake `fetch` to canned responses per mic route, recording
 *  every call (url + init) for assertions. `streamReader` (if given)
 *  backs `GET /api/mic/stream/:id`'s response body. */
function install_fetch_mock(options: {
  startOk?: boolean;
  startBody?: unknown;
  streamReader?: ReturnType<typeof make_controlled_reader>['reader'];
}) {
  const startOk = options.startOk ?? true;
  const startBody = options.startBody ?? { streamId: 'abc' };
  const calls: { url: string; init?: RequestInit }[] = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/mic/start') {
      return { ok: startOk, json: async () => startBody } as Response;
    }
    if (url.startsWith('/api/mic/stream/')) {
      return { ok: true, body: { getReader: () => options.streamReader } } as unknown as Response;
    }
    if (url.startsWith('/api/mic/flush/') || url.startsWith('/api/mic/stop/') || url.startsWith('/api/mic/audio/')) {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    throw new Error(`mic_engine.test.ts: unexpected fetch url ${url}`);
  }) as typeof fetch;

  return calls;
}

async function wait_until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('wait_until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('mic_engine: before start()', () => {
  it('stop() is a harmless no-op, even before start()', () => {
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });
    expect(() => engine.stop()).not.toThrow();
  });

  it('notify_speaker_change() before start() is a no-op — no fetch call', () => {
    install_fetch_mock({});
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });
    engine.notify_speaker_change('R');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('mic_engine: start() failure paths call on_unavailable', () => {
  it('POST /api/mic/start returning non-ok (e.g. 503 whisper_unavailable) fires on_unavailable', async () => {
    install_fetch_mock({ startOk: false });
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_unavailable: () => (fired = true) });
    await engine.start();
    expect(fired).toBe(true);
  });

  it('a network-level fetch failure on /api/mic/start fires on_unavailable, never throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_unavailable: () => (fired = true) });
    await expect(engine.start()).resolves.toBeUndefined();
    expect(fired).toBe(true);
  });

  it('a malformed /api/mic/start body (no streamId) fires on_unavailable', async () => {
    install_fetch_mock({ startBody: { ok: true } });
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_unavailable: () => (fired = true) });
    await engine.start();
    expect(fired).toBe(true);
  });

  it('the SSE stream ending unexpectedly (server closed it, not our own stop()) fires on_unavailable', async () => {
    const { reader, end } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_unavailable: () => (fired = true) });
    await engine.start();
    end(); // stream ends with no events ever sent — simulates a dropped connection
    await wait_until(() => fired);
  });
});

describe('mic_engine: real event pipeline (fetch-mocked SSE)', () => {
  it('POSTs to /api/mic/start, then GETs /api/mic/stream/:id with the returned streamId', async () => {
    const { reader } = make_controlled_reader();
    const calls = install_fetch_mock({ startBody: { streamId: 'my-stream-id' }, streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });
    await engine.start();
    await wait_until(() => calls.some((c) => c.url === '/api/mic/stream/my-stream-id'));
    engine.stop();
  });

  it('emits a partial EngineEvent, stamped with the current speaker, for a partial SSE event', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });

    const partials: EngineEvent[] = [];
    engine.on('partial', (e) => partials.push(e));

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 0.4, text: 'hel', final: false }));
    await wait_until(() => partials.length >= 1);

    expect(partials[0]).toEqual({ speaker: 'L', tStart: 0, tEnd: 0.4, text: 'hel', final: false });

    engine.stop();
  });

  it('emits a segment EngineEvent for a final SSE event', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'R' });

    const segments: EngineEvent[] = [];
    engine.on('segment', (e) => segments.push(e));

    await engine.start();
    push(sse('final', { tStart: 0, tEnd: 1.2, text: 'hello there', final: true }));
    await wait_until(() => segments.length >= 1);

    expect(segments[0]).toEqual({ speaker: 'R', tStart: 0, tEnd: 1.2, text: 'hello there', final: true });

    engine.stop();
  });

  it('drops an empty-text final (a flush with nothing buffered) rather than emitting a spurious empty segment', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });

    const segments: EngineEvent[] = [];
    engine.on('segment', (e) => segments.push(e));

    await engine.start();
    push(sse('final', { tStart: 0, tEnd: 0, text: '', final: true }));
    push(sse('final', { tStart: 5, tEnd: 5.1, text: 'real text', final: true })); // sentinel — proves the loop kept running
    await wait_until(() => segments.length >= 1);

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('real text');

    engine.stop();
  });

  it('silently skips a malformed SSE payload (missing required fields) without breaking the stream', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });

    const events: EngineEvent[] = [];
    engine.on('partial', (e) => events.push(e));

    await engine.start();
    push(sse('partial', { tStart: 0, text: 'missing tEnd' })); // malformed — dropped
    push(sse('partial', { tStart: 1, tEnd: 1.5, text: 'ok', final: false })); // well-formed — still processed
    await wait_until(() => events.length >= 1);

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('ok');

    engine.stop();
  });

  it('live-transcription-visibility fix: emits with speaker: null while no speaker has ever been chosen, rather than dropping the event', async () => {
    // Was: "never emits at all... (get_current_speaker returns null)" —
    // that encoded the exact bug reported (18 correct SSE events arrived,
    // the page rendered nothing). EngineEvent.speaker is now
    // Speaker | null (shared/engine.ts) specifically so this text doesn't
    // have to be silently withheld — see mic_engine_core.ts's "fix round
    // 3" header comment.
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => null });

    const events: EngineEvent[] = [];
    engine.on('partial', (e) => events.push(e));
    engine.on('segment', (e) => events.push(e));

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 0.4, text: 'no speaker yet', final: false }));
    await wait_until(() => events.length >= 1);

    expect(events[0]).toEqual({ speaker: null, tStart: 0, tEnd: 0.4, text: 'no speaker yet', final: false });

    engine.stop();
  });
});

describe('mic_engine: notify_speaker_change', () => {
  it('regression (the "nothing is ever rendered" bug): a first-ever speaker choice does NOT flush, the pre-choice text is emitted (not dropped), and the same window\'s next tick reports the newly-claimed speaker', async () => {
    // Reproduces the reported failure: a fresh mic session (no speaker
    // chosen yet, `get_current_speaker` returning null the whole time the
    // tracker is constructed). Before this fix, `handle_server_event`
    // dropped every event while unattributed (`EngineEvent.speaker` was
    // non-nullable) AND the old `request_speaker_change` treated a
    // first-ever choice as "an actual change," firing a flush that split
    // the still-open window in two — so what was said before the keypress
    // was genuinely unrecoverable. Now: the pre-choice event is emitted
    // (speaker: null, live-transcription-visibility fix), the first-ever
    // choice still does NOT flush (mic_engine_core.ts's `request_speaker_
    // change` — unchanged, see this module's header comment), so the SAME
    // window keeps growing, and its next tick carries the newly claimed
    // speaker. Re-attributing that SAME transcript turn in place (rather
    // than emitting two disconnected EngineEvents) is engine_bridge.ts's
    // job, not this layer's — see tests/engine_bridge.test.ts's "late
    // attribution" cases for that half of the fix.
    const { reader, push } = make_controlled_reader();
    const calls = install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => null });

    const events: EngineEvent[] = [];
    engine.on('partial', (e) => events.push(e));
    engine.on('segment', (e) => events.push(e));

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 2.6, text: 'said before a speaker was chosen', final: false }));
    await wait_until(() => events.length >= 1);
    expect(events[0]).toEqual({ speaker: null, tStart: 0, tEnd: 2.6, text: 'said before a speaker was chosen', final: false });

    calls.length = 0;
    engine.notify_speaker_change('L'); // the harness's "press ArrowLeft to claim the left speaker"
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url.startsWith('/api/mic/flush/'))).toBe(false); // no window split

    // The SAME window (same tStart) ticks again, now correctly labeled.
    push(sse('partial', { tStart: 0, tEnd: 4.3, text: 'said before a speaker was chosen and more', final: false }));
    await wait_until(() => events.length >= 2);

    expect(events[1]).toMatchObject({ speaker: 'L', tStart: 0, text: 'said before a speaker was chosen and more' });

    engine.stop();
  });

  it('a re-press of the already-current speaker does NOT POST /api/mic/flush', async () => {
    const { reader } = make_controlled_reader();
    const calls = install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });
    await engine.start();
    calls.length = 0;

    engine.notify_speaker_change('L');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url.startsWith('/api/mic/flush/'))).toBe(false);

    engine.stop();
  });

  it('a speaker change requested BEFORE streamId exists (start() still in flight) is not lost — it flushes as soon as streamId is known', async () => {
    const { reader } = make_controlled_reader();
    const calls = install_fetch_mock({ streamReader: reader, startBody: { streamId: 'race-id' } });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });

    const startPromise = engine.start();
    // Synchronous call, interleaved before start()'s own `await fetch(...)`
    // for /api/mic/start has resolved — streamId is still null at this
    // exact instant.
    engine.notify_speaker_change('R');
    await startPromise;

    await wait_until(() => calls.some((c) => c.url === '/api/mic/flush/race-id'));

    engine.stop();
  });

  it('an actual speaker change POSTs /api/mic/flush/:id', async () => {
    const { reader } = make_controlled_reader();
    const calls = install_fetch_mock({ streamReader: reader, startBody: { streamId: 'flush-me' } });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });
    await engine.start();
    calls.length = 0;

    engine.notify_speaker_change('R');
    await wait_until(() => calls.some((c) => c.url === '/api/mic/flush/flush-me'));

    engine.stop();
  });

  it('the outgoing speaker\'s in-flight final still reports the OLD speaker; only the next event gets the new one', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });

    const events: EngineEvent[] = [];
    engine.on('partial', (e) => events.push(e));
    engine.on('segment', (e) => events.push(e));

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 0.4, text: 'still L', final: false }));
    await wait_until(() => events.length >= 1);

    engine.notify_speaker_change('R'); // switch requested mid-utterance

    push(sse('final', { tStart: 0, tEnd: 1.0, text: 'still L final', final: true }));
    await wait_until(() => events.length >= 2);
    expect(events[1]).toMatchObject({ speaker: 'L', text: 'still L final' });

    push(sse('partial', { tStart: 1.0, tEnd: 1.3, text: 'now R', final: false }));
    await wait_until(() => events.length >= 3);
    expect(events[2]).toMatchObject({ speaker: 'R', text: 'now R' });

    engine.stop();
  });
});

describe('mic_engine: on_stall_change (qwen-asr-engine handover, Task B item 3)', () => {
  it('fires true when no SSE event arrives within stallMs of stream start', async () => {
    const { reader } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let stalled: boolean | null = null;
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_stall_change: (v) => (stalled = v),
      stallMs: 20,
      stallPollMs: 5
    });

    await engine.start();
    await wait_until(() => stalled === true);

    engine.stop();
  });

  it('does not fire while events keep arriving inside the window (an empty-text tick still counts)', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let stalled: boolean | null = null;
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_stall_change: (v) => (stalled = v),
      stallMs: 60,
      stallPollMs: 5
    });

    await engine.start();
    // Empty-text ticks are dropped as segments (see the "drops an
    // empty-text final" test above) but must still count as proof the
    // pipe is alive for stall-detection purposes. Each gap stays well
    // under `stallMs` so the watchdog never crosses its threshold.
    for (let i = 0; i < 5; i += 1) {
      push(sse('final', { tStart: 0, tEnd: 0, text: '', final: true }));
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(stalled).toBeNull();
    engine.stop();
  });

  it('recovers: fires false the moment an event arrives after a stall', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const history: boolean[] = [];
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_stall_change: (v) => history.push(v),
      stallMs: 15,
      stallPollMs: 5
    });

    await engine.start();
    await wait_until(() => history.includes(true));

    push(sse('final', { tStart: 0, tEnd: 0, text: '', final: true }));
    await wait_until(() => history.includes(false));

    expect(history).toEqual([true, false]);
    engine.stop();
  });

  it('a deliberate stop() before any stall never fires the callback', async () => {
    const { reader } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_stall_change: () => (fired = true),
      stallMs: 200,
      stallPollMs: 5
    });

    await engine.start();
    engine.stop();
    await new Promise((r) => setTimeout(r, 30));

    expect(fired).toBe(false);
  });

  it('stop() clears the watchdog interval: no callback fires after teardown', async () => {
    const { reader } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_stall_change: () => (fired = true),
      stallMs: 15,
      stallPollMs: 5
    });

    await engine.start();
    engine.stop();
    await new Promise((r) => setTimeout(r, 40)); // well past stallMs, engine already stopped

    expect(fired).toBe(false);
  });
});

describe('mic_engine: on_lag_change (live-subtitles handover, item 4)', () => {
  /** Returns each value in `values` in order on successive calls,
   *  repeating the last one once exhausted — used to give `options.now`
   *  a scripted, deterministic clock instead of racing real `Date.now()`. */
  function scripted_clock(...values: number[]): () => number {
    let i = 0;
    return () => {
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      return v;
    };
  }

  it('reports elapsed-since-start minus tEnd, using the injected clock', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const lags: number[] = [];
    // First call: `streamStartedAt` at start(). Second call: report_lag's
    // own `nowFn()` read when the SSE event is dispatched — 900ms later.
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_lag_change: (lag) => lags.push(lag),
      now: scripted_clock(1_000, 1_900)
    });

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 0.4, text: 'hel', final: false })); // tEnd=400ms
    await wait_until(() => lags.length >= 1);

    // elapsedMs = 1900 - 1000 = 900; lag = 900 - 400 = 500
    expect(lags[0]).toBe(500);

    engine.stop();
  });

  it('fires even for an empty-text tick that handle_server_event itself drops', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const lags: number[] = [];
    const segments: EngineEvent[] = [];
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_lag_change: (lag) => lags.push(lag),
      now: scripted_clock(0, 1_200)
    });
    engine.on('segment', (e) => segments.push(e));

    await engine.start();
    push(sse('final', { tStart: 0, tEnd: 0, text: '', final: true })); // dropped as a segment
    await wait_until(() => lags.length >= 1);

    expect(lags[0]).toBe(1200); // elapsedMs=1200, tEnd=0 -> lag=1200
    expect(segments).toHaveLength(0); // confirms this really is the empty-text drop path

    engine.stop();
  });

  it('never fires for a malformed payload (validation happens before the lag read)', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({
      get_current_speaker: () => 'L',
      on_lag_change: () => (fired = true)
    });

    await engine.start();
    push(sse('partial', { tStart: 0, text: 'missing tEnd' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fired).toBe(false);
    engine.stop();
  });
});

describe('mic_engine: on_decode_ms (live-transcription-visibility fix)', () => {
  it('fires with the payload\'s decodeMs field, for both partial and final events', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const readings: number[] = [];
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_decode_ms: (ms) => readings.push(ms) });

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 0.4, text: 'hel', final: false, decodeMs: 1234 }));
    await wait_until(() => readings.length >= 1);
    push(sse('final', { tStart: 0, tEnd: 1.2, text: 'hello there', final: true, decodeMs: 987 }));
    await wait_until(() => readings.length >= 2);

    expect(readings).toEqual([1234, 987]);
    engine.stop();
  });

  it('fires even for an empty-text tick that handle_server_event itself drops (same convention as on_lag_change)', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const readings: number[] = [];
    const segments: EngineEvent[] = [];
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_decode_ms: (ms) => readings.push(ms) });
    engine.on('segment', (e) => segments.push(e));

    await engine.start();
    push(sse('final', { tStart: 0, tEnd: 0, text: '', final: true, decodeMs: 55 }));
    await wait_until(() => readings.length >= 1);

    expect(readings).toEqual([55]);
    expect(segments).toHaveLength(0);
    engine.stop();
  });

  it('never fires when the payload omits decodeMs (server-side flush with nothing buffered)', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_decode_ms: () => (fired = true) });

    await engine.start();
    push(sse('final', { tStart: 0, tEnd: 0, text: '', final: true })); // no decodeMs key at all
    await new Promise((r) => setTimeout(r, 30));

    expect(fired).toBe(false);
    engine.stop();
  });

  it('ignores a non-numeric decodeMs rather than throwing or forwarding garbage', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_decode_ms: () => (fired = true) });

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 0.4, text: 'x', final: false, decodeMs: 'slow' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fired).toBe(false);
    engine.stop();
  });
});

describe('mic_engine: on_pending_audio_change (live-transcription-visibility fix)', () => {
  // `on_audio_started`/`mark_audio_captured` are only reachable from real
  // `ScriptProcessorNode.onaudioprocess` callbacks (`start_capture`'s real
  // Web Audio path — this repo's vitest run has no Web Audio, same
  // environment gap audio_recorder.ts's own header comment names), so
  // this suite exercises `update_pending_audio`'s SSE-arrival half only,
  // via a directly-invoked private hook there is no way to reach without
  // real audio capture: proven instead by the headless Playwright proof
  // (see the result report) that a real mic session's status line reads
  // "waiting for audio…" before capture starts and flips once it does.
  it('never fires before any audio has ever been captured, regardless of how many SSE events arrive', async () => {
    const { reader, push } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_pending_audio_change: () => (fired = true) });

    await engine.start();
    push(sse('partial', { tStart: 0, tEnd: 0.4, text: 'x', final: false }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fired).toBe(false); // no on_audio_started ever fired in this test — no real capture path in vitest
    engine.stop();
  });
});

describe('mic_engine: stop()', () => {
  it('aborts the SSE fetch signal and POSTs /api/mic/stop/:id', async () => {
    const { reader } = make_controlled_reader();
    const calls = install_fetch_mock({ streamReader: reader, startBody: { streamId: 'stop-me' } });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });
    await engine.start();

    const streamCall = calls.find((c) => c.url === '/api/mic/stream/stop-me');
    const signal = streamCall?.init?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);

    engine.stop();

    expect(signal?.aborted).toBe(true);
    await wait_until(() => calls.some((c) => c.url === '/api/mic/stop/stop-me'));
  });

  it('a dropped connection AFTER stop() does not fire on_unavailable (deliberate stop, not a failure)', async () => {
    const { reader, end } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    let fired = false;
    const engine = create_mic_engine({ get_current_speaker: () => 'L', on_unavailable: () => (fired = true) });
    await engine.start();

    engine.stop();
    end();
    await new Promise((r) => setTimeout(r, 30));

    expect(fired).toBe(false);
  });

  it('calling stop() twice is harmless', async () => {
    const { reader } = make_controlled_reader();
    install_fetch_mock({ streamReader: reader });
    const engine = create_mic_engine({ get_current_speaker: () => 'L' });
    await engine.start();
    engine.stop();
    expect(() => engine.stop()).not.toThrow();
  });
});
