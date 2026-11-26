// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handle_request } from '../server/lib/router.mjs';
import { ollama_generate } from '../server/lib/ollama.mjs';

/** Same fake req pattern as llm_routes.test.mjs/session_routes.test.mjs. */
function fake_req(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

/**
 * Fake ServerResponse for the SSE route: unlike llm_routes.test.mjs's plain
 * buffering fake_res, this needs to (a) accumulate MULTIPLE `write()` calls
 * (an SSE stream is many small writes, never one final `end(chunk)`), (b)
 * behave like a real EventEmitter so router.mjs's `res.on('close', ...)`
 * abort-detection wiring works, and (c) track `writableEnded` the same way
 * a real `http.ServerResponse` does, since that's exactly what router.mjs's
 * abort guard (`if (!res.writableEnded)`) checks.
 */
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
  // Defined via `Object.defineProperty` rather than as a `get events()`
  // inside the object literal above passed to `Object.assign`:
  // `Object.assign` copies accessor properties by invoking the getter ONCE
  // at copy time and assigning its (at-that-moment) return value as a
  // plain, now-frozen data property — it does NOT preserve the accessor
  // itself. That would silently turn this into a snapshot of `text` taken
  // before any `write()` ever ran (always `''`), instead of the live view
  // every call site here actually needs.
  Object.defineProperty(res, 'events', {
    /** Every complete `event:`/`data:` block written so far, parsed. */
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

function seg(id, speaker, tStart, tEnd, text, final = true) {
  return { id, speaker, tStart, tEnd, text, final };
}

/** Simulates the client dropping the connection (EventSource close /
 *  fetch AbortController.abort()) — router.mjs listens for exactly this. */
function simulate_client_abort(res) {
  res.emit('close');
}

describe('POST /api/factcheck — SSE event order (stubbed ollama)', () => {
  it('streams quick -> deep_eta -> deep -> done in order, with the right payload shapes', async () => {
    const context = [seg('s1', 'L', 0, 3, 'Vienna has about two million residents.')];
    const req = fake_req(
      'POST',
      '/api/factcheck',
      JSON.stringify({ question: 'How many people live in Vienna?', context, models: { quick: 'q-model', deep: 'd-model' } })
    );
    const res = fake_sse_res();

    const calls = [];
    await handle_request(req, res, {
      ollamaGenerate: async ({ model, prompt }) => {
        calls.push(model);
        if (model === 'q-model' && calls.filter((m) => m === 'q-model').length === 1) {
          return { unavailable: false, response: 'About two million.' };
        }
        if (model === 'd-model') {
          return { unavailable: false, response: 'Roughly 1.97 million as of the last census.' };
        }
        // second q-model call: the contradiction check
        expect(prompt).toContain('About two million.');
        expect(prompt).toContain('Roughly 1.97 million');
        return { unavailable: false, response: 'no, they are consistent.' };
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');

    const events = res.events;
    expect(events.map((e) => e.event)).toEqual(['quick', 'deep_eta', 'deep', 'done']);

    expect(events[0].data).toMatchObject({ text: 'About two million.', model: 'q-model' });
    expect(typeof events[0].data.ms).toBe('number');

    expect(events[1].data).toEqual({ etaMs: 45000 }); // no .deep_stats.json in this fresh tmp dir yet

    expect(events[2].data).toMatchObject({
      text: 'Roughly 1.97 million as of the last census.',
      model: 'd-model',
      contradicts: false,
      nuance: 'they are consistent.'
    });
    expect(typeof events[2].data.ms).toBe('number');

    expect(events[3].data).toEqual({});
    expect(res.writableEnded).toBe(true);
  });

  it('reports contradicts:true with the nuance sentence when the contradiction check says yes', async () => {
    const req = fake_req(
      'POST',
      '/api/factcheck',
      JSON.stringify({ question: 'q', context: [], models: { quick: 'q-model', deep: 'd-model' } })
    );
    const res = fake_sse_res();

    let quickCallCount = 0;
    await handle_request(req, res, {
      ollamaGenerate: async ({ model }) => {
        if (model === 'q-model') {
          quickCallCount += 1;
          if (quickCallCount === 1) return { unavailable: false, response: 'It was founded in 1147.' };
          return { unavailable: false, response: 'Yes, the dates given differ by a century.' };
        }
        return { unavailable: false, response: 'It was actually founded in 1247.' };
      }
    });

    const deepEvent = res.events.find((e) => e.event === 'deep');
    expect(deepEvent.data.contradicts).toBe(true);
    expect(deepEvent.data.nuance).toBe('the dates given differ by a century.');
  });

  it('fix round 1: a throw during the contradiction call (not an {unavailable:true} resolution) does not truncate the stream — deep/done still arrive, contradicts:false', async () => {
    const req = fake_req(
      'POST',
      '/api/factcheck',
      JSON.stringify({ question: 'q', context: [], models: { quick: 'q-model', deep: 'd-model' } })
    );
    const res = fake_sse_res();

    let quickCallCount = 0;
    await handle_request(req, res, {
      ollamaGenerate: async ({ model }) => {
        if (model === 'q-model') {
          quickCallCount += 1;
          if (quickCallCount === 1) return { unavailable: false, response: 'a quick answer' };
          // Third call overall (second q-model call) is the contradiction
          // check — throws instead of the usual never-throws
          // {unavailable:true} resolution, simulating a genuinely
          // unexpected error (not a modeled Ollama-down case).
          throw new Error('boom: unexpected failure during contradiction check');
        }
        return { unavailable: false, response: 'a deep answer' };
      }
    });

    const events = res.events;
    expect(events.map((e) => e.event)).toEqual(['quick', 'deep_eta', 'deep', 'done']);
    const deepEvent = events.find((e) => e.event === 'deep');
    expect(deepEvent.data).toMatchObject({ text: 'a deep answer', contradicts: false, nuance: '' });
    expect(res.writableEnded).toBe(true);
  });

  it('skips the contradiction check (contradicts:false, no nuance) when the deep call was unavailable', async () => {
    const req = fake_req(
      'POST',
      '/api/factcheck',
      JSON.stringify({ question: 'q', context: [], models: { quick: 'q-model', deep: 'd-model' } })
    );
    const res = fake_sse_res();

    let quickModelCallCount = 0;
    await handle_request(req, res, {
      ollamaGenerate: async ({ model }) => {
        if (model === 'q-model') {
          quickModelCallCount += 1;
          return { unavailable: false, response: 'a quick answer' };
        }
        return { unavailable: true }; // deep model down
      }
    });

    const events = res.events;
    expect(events.map((e) => e.event)).toEqual(['quick', 'deep_eta', 'deep', 'done']);
    const deepEvent = events.find((e) => e.event === 'deep');
    expect(deepEvent.data).toMatchObject({ text: '', contradicts: false, nuance: '' });
    // Exactly ONE q-model call (the initial quick answer) — a second
    // q-model call would be the contradiction check, which must never fire
    // when the deep call was unavailable (nothing meaningful to compare).
    expect(quickModelCallCount).toBe(1);
  });

  it('degrades to empty text (never throws) when Ollama is unreachable for every call', async () => {
    const req = fake_req(
      'POST',
      '/api/factcheck',
      JSON.stringify({ question: 'q', context: [], models: { quick: 'q-model', deep: 'd-model' } })
    );
    const res = fake_sse_res();

    await handle_request(req, res, { ollamaGenerate: async () => ({ unavailable: true }) });

    const events = res.events;
    expect(events.map((e) => e.event)).toEqual(['quick', 'deep_eta', 'deep', 'done']);
    expect(events[0].data.text).toBe('');
    expect(events[2].data).toMatchObject({ text: '', contradicts: false, nuance: '' });
  });

  it('returns 400 invalid_body for a missing/blank question or malformed JSON', async () => {
    const res1 = fake_sse_res();
    await handle_request(fake_req('POST', '/api/factcheck', JSON.stringify({ context: [] })), res1, {});
    expect(res1.statusCode).toBe(400);

    const res2 = fake_sse_res();
    await handle_request(fake_req('POST', '/api/factcheck', JSON.stringify({ question: '  ', context: [] })), res2, {});
    expect(res2.statusCode).toBe(400);

    const res3 = fake_sse_res();
    await handle_request(fake_req('POST', '/api/factcheck', 'not json'), res3, {});
    expect(res3.statusCode).toBe(400);
  });

  it('falls back to default model names when models is omitted', async () => {
    const req = fake_req('POST', '/api/factcheck', JSON.stringify({ question: 'q', context: [] }));
    const res = fake_sse_res();

    const modelsUsed = new Set();
    await handle_request(req, res, {
      ollamaGenerate: async ({ model }) => {
        modelsUsed.add(model);
        return { unavailable: false, response: 'x' };
      }
    });

    expect(modelsUsed.has('qwen3:4b')).toBe(true);
    expect(modelsUsed.has('qwen3.6-27b-iq4:latest')).toBe(true);
  });
});

describe('POST /api/factcheck — eta reflects the rolling stats on disk', () => {
  let workDir;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'talkweave-factcheck-route-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('reports the seed (45000) with no stats file, then a real average after one completed deep call', async () => {
    const req1 = fake_req('POST', '/api/factcheck', JSON.stringify({ question: 'q', context: [] }));
    const res1 = fake_sse_res();
    await handle_request(req1, res1, {
      sessionsRoot: workDir,
      ollamaGenerate: async () => ({ unavailable: false, response: 'x' })
    });
    expect(res1.events.find((e) => e.event === 'deep_eta').data.etaMs).toBe(45000);

    // The deep call's actual measured duration got written to
    // .deep_stats.json — verified directly on disk, in the tmp dir, per
    // task-10-brief.md's "eta stats rolling update on disk in a tmp dir".
    const stats = JSON.parse(await readFile(join(workDir, '.deep_stats.json'), 'utf-8'));
    expect(stats.count).toBe(1);
    expect(stats.avgMs).toBeGreaterThanOrEqual(0);

    const req2 = fake_req('POST', '/api/factcheck', JSON.stringify({ question: 'q2', context: [] }));
    const res2 = fake_sse_res();
    await handle_request(req2, res2, {
      sessionsRoot: workDir,
      ollamaGenerate: async () => ({ unavailable: false, response: 'x' })
    });
    // No longer the seed — a real recorded average is now on disk.
    expect(res2.events.find((e) => e.event === 'deep_eta').data.etaMs).not.toBe(45000);

    const stats2 = JSON.parse(await readFile(join(workDir, '.deep_stats.json'), 'utf-8'));
    expect(stats2.count).toBe(2);
  });

  it('does NOT update the stats file when the deep call itself was unavailable', async () => {
    const req = fake_req('POST', '/api/factcheck', JSON.stringify({ question: 'q', context: [] }));
    const res = fake_sse_res();
    await handle_request(req, res, {
      sessionsRoot: workDir,
      ollamaGenerate: async ({ model }) => (model.includes('27b') ? { unavailable: true } : { unavailable: false, response: 'x' })
    });

    await expect(readFile(join(workDir, '.deep_stats.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('POST /api/factcheck — abort kills the upstream Ollama request', () => {
  let stub;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
  });

  it('destroys the in-flight deep request on the real upstream when the client (res) closes the connection', async () => {
    let handlerEntered = false;
    let sawAbortedOrClose = false;
    let markSeen;
    const seenPromise = new Promise((resolve) => {
      markSeen = resolve;
    });

    // A real HTTP stub, matching ollama.test.mjs's own `start_stub`
    // pattern, but built inline here so this test can distinguish the
    // QUICK call (answers immediately) from the DEEP call (hangs, headers
    // never sent, so router.mjs's `handle_factcheck` is genuinely
    // awaiting it when the abort fires).
    const realServer = createServer((httpReq, httpRes) => {
      let raw = '';
      httpReq.on('data', (c) => (raw += c));
      httpReq.on('end', () => {
        const parsed = JSON.parse(raw);
        if (parsed.model === 'quick-real') {
          httpRes.writeHead(200, { 'Content-Type': 'application/json' });
          httpRes.end(JSON.stringify({ response: 'quick answer' }));
          return;
        }
        // The DEEP call: never respond — this is what's in flight when the
        // client aborts below.
        handlerEntered = true;
        const mark = () => {
          sawAbortedOrClose = true;
          markSeen();
        };
        httpReq.on('aborted', mark);
        httpReq.on('close', mark);
      });
    });
    stub = await new Promise((resolve) => {
      realServer.listen(0, '127.0.0.1', () => {
        const { port } = realServer.address();
        resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => realServer.close(r)) });
      });
    });

    const req = fake_req(
      'POST',
      '/api/factcheck',
      JSON.stringify({ question: 'q', context: [], models: { quick: 'quick-real', deep: 'deep-real' } })
    );
    const res = fake_sse_res();

    // Real ollama.mjs, pointed at the stub, with the router's `signal`
    // forwarded straight through — exactly the seam router.mjs's
    // `default_ollama_generate` uses in production, just with an injected
    // `baseUrl` so this test never touches the real Ollama daemon.
    const handlerPromise = handle_request(req, res, {
      ollamaGenerate: ({ model, prompt, signal, stream }) =>
        ollama_generate({ model, prompt, baseUrl: stub.baseUrl, signal, stream })
    });

    // Wait for the quick event (proves the deep call is the one now in
    // flight) before aborting.
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (res.events.some((e) => e.event === 'quick')) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    // Give the deep request a moment to actually reach the stub.
    await new Promise((r) => setTimeout(r, 50));

    simulate_client_abort(res);
    await handlerPromise;

    await Promise.race([seenPromise, new Promise((r) => setTimeout(r, 1000))]);
    expect(handlerEntered).toBe(true);
    expect(sawAbortedOrClose).toBe(true);

    // No `deep`/`done` event was ever written past the point of the abort
    // — the handler returned early rather than completing the stream.
    expect(res.events.some((e) => e.event === 'deep')).toBe(false);
    expect(res.events.some((e) => e.event === 'done')).toBe(false);
  });
});
