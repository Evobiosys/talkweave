// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { handle_request } from '../server/lib/router.mjs';
import { ollama_generate } from '../server/lib/ollama.mjs';

/** Same fake req pattern as factcheck_routes.test.mjs/llm_routes.test.mjs. */
function fake_req(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

/**
 * A real EventEmitter (so router.mjs's `res.on('close', ...)` abort
 * wiring works, same rationale as factcheck_routes.test.mjs's
 * `fake_sse_res`) but for a route that answers with ONE plain JSON
 * `end(chunk)` rather than several `write()` SSE blocks.
 */
function fake_res() {
  const emitter = new EventEmitter();
  const chunks = [];
  const res = Object.assign(emitter, {
    statusCode: null,
    headers: null,
    writableEnded: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      res.writableEnded = true;
    }
  });
  // `Object.defineProperty`, not a plain object-literal getter passed to
  // `Object.assign` — same reasoning as factcheck_routes.test.mjs's
  // `events` getter: `Object.assign` invokes an accessor ONCE at copy
  // time and freezes that (empty, pre-`end()`) return value as a plain
  // data property, which would make `res.body` permanently `''`.
  Object.defineProperty(res, 'body', {
    get() {
      return Buffer.concat(chunks).toString('utf-8');
    }
  });
  return res;
}

function candidate(overrides) {
  return { segmentId: 's1', speaker: 'L', tStart: 0, text: 'the museum funding proposal was rejected', ...overrides };
}

describe('POST /api/ask — validation', () => {
  it('returns 400 for malformed JSON, a missing/blank question, an invalid mode, or non-array candidates', async () => {
    const bad = [
      'not json',
      JSON.stringify({ mode: 'recall', question: '', candidates: [] }),
      JSON.stringify({ mode: 'recall', candidates: [] }),
      JSON.stringify({ mode: 'not-a-real-mode', question: 'q', candidates: [] }),
      JSON.stringify({ mode: 'recall', question: 'q', candidates: 'nope' })
    ];
    for (const body of bad) {
      const res = fake_res();
      await handle_request(fake_req('POST', '/api/ask', body), res, {});
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('POST /api/ask — recall ("did we talk about this before?")', () => {
  it('judges the highlighted passage against only the TOP candidate, and maps contradicts -> sameTopic', async () => {
    const req = fake_req(
      'POST',
      '/api/ask',
      JSON.stringify({
        mode: 'recall',
        question: 'the museum funding proposal was rejected',
        candidates: [candidate({ segmentId: 's1' }), candidate({ segmentId: 's2', text: 'a second, lower-ranked match' })]
      })
    );
    const res = fake_res();

    let capturedPrompt = null;
    let callCount = 0;
    await handle_request(req, res, {
      ollamaGenerate: async ({ model, prompt }) => {
        callCount += 1;
        capturedPrompt = prompt;
        expect(model).toBe('qwen3:4b');
        return { unavailable: false, response: 'yes, same topic, the rejection is discussed both times.' };
      }
    });

    expect(callCount).toBe(1); // never asked about the second candidate
    expect(capturedPrompt).toContain('the museum funding proposal was rejected');
    expect(capturedPrompt).not.toContain('a second, lower-ranked match');

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toEqual({
      ok: true,
      unavailable: false,
      text: 'same topic, the rejection is discussed both times.',
      sameTopic: true
    });
  });

  it('answers unavailable:null (never contacts Ollama) when there are no candidates to judge', async () => {
    const req = fake_req('POST', '/api/ask', JSON.stringify({ mode: 'recall', question: 'q', candidates: [] }));
    const res = fake_res();

    let called = false;
    await handle_request(req, res, { ollamaGenerate: async () => ((called = true), { unavailable: false, response: 'x' }) });

    expect(called).toBe(false);
    expect(JSON.parse(res.body)).toEqual({ ok: true, unavailable: null, text: null });
  });

  it('degrades to unavailable:true, never throws or 5xxs, when Ollama is unreachable', async () => {
    const req = fake_req('POST', '/api/ask', JSON.stringify({ mode: 'recall', question: 'q', candidates: [candidate({})] }));
    const res = fake_res();

    await handle_request(req, res, { ollamaGenerate: async () => ({ unavailable: true }) });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, unavailable: true, text: null });
  });
});

describe('POST /api/ask — contradiction ("was this contradicted elsewhere?")', () => {
  it('reuses factcheck.mjs\'s build_contradiction_prompt/parse_contradiction_response and reports contradicts + nuance', async () => {
    const req = fake_req(
      'POST',
      '/api/ask',
      JSON.stringify({
        mode: 'contradiction',
        question: 'the museum funding proposal was approved',
        candidates: [candidate({ text: 'later they said the museum funding proposal was actually rejected' })]
      })
    );
    const res = fake_res();

    await handle_request(req, res, {
      ollamaGenerate: async () => ({
        unavailable: false,
        response: 'yes, this directly contradicts the earlier statement about approval.'
      })
    });

    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      unavailable: false,
      text: 'this directly contradicts the earlier statement about approval.',
      contradicts: true
    });
  });

  it('judges the top TWO candidates sequentially, stopping at the first genuine contradiction — a rank-1 restatement must not crowd out a rank-2 contradiction', async () => {
    const req = fake_req(
      'POST',
      '/api/ask',
      JSON.stringify({
        mode: 'contradiction',
        question: 'the grant is forty thousand euros',
        candidates: [
          candidate({ segmentId: 's9', text: 'yes, we spent forty thousand euros just like before, same figure' }), // rank 1: restatement, agrees
          candidate({ segmentId: 's14', text: 'actually the grant was only twenty thousand euros in the end' }) // rank 2: the real contradiction
        ]
      })
    );
    const res = fake_res();

    const promptsSeen = [];
    await handle_request(req, res, {
      ollamaGenerate: async ({ prompt }) => {
        promptsSeen.push(prompt);
        if (prompt.includes('just like before')) {
          return { unavailable: false, response: 'no, this simply restates the same figure in agreement.' };
        }
        return { unavailable: false, response: 'yes, twenty thousand directly contradicts forty thousand.' };
      }
    });

    expect(promptsSeen.length).toBe(2); // both candidates were actually checked
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      unavailable: false,
      text: 'twenty thousand directly contradicts forty thousand.',
      contradicts: true
    });
  });

  it('stops after the FIRST candidate when it already contradicts — never asks about the second', async () => {
    const req = fake_req(
      'POST',
      '/api/ask',
      JSON.stringify({
        mode: 'contradiction',
        question: 'q',
        candidates: [candidate({ segmentId: 's1', text: 'first candidate' }), candidate({ segmentId: 's2', text: 'second candidate' })]
      })
    );
    const res = fake_res();

    let callCount = 0;
    await handle_request(req, res, {
      ollamaGenerate: async () => {
        callCount += 1;
        return { unavailable: false, response: 'yes, this contradicts it.' };
      }
    });

    expect(callCount).toBe(1);
    expect(JSON.parse(res.body)).toMatchObject({ contradicts: true });
  });

  it('reports contradicts:false with the LAST candidate checked\'s nuance when neither of the top two contradicts', async () => {
    const req = fake_req(
      'POST',
      '/api/ask',
      JSON.stringify({
        mode: 'contradiction',
        question: 'q',
        candidates: [candidate({ segmentId: 's1', text: 'first candidate' }), candidate({ segmentId: 's2', text: 'second candidate' })]
      })
    );
    const res = fake_res();

    let callCount = 0;
    await handle_request(req, res, {
      ollamaGenerate: async () => {
        callCount += 1;
        return { unavailable: false, response: `no, they agree (call ${callCount}).` };
      }
    });

    expect(callCount).toBe(2);
    expect(JSON.parse(res.body)).toEqual({ ok: true, unavailable: false, text: 'they agree (call 2).', contradicts: false });
  });

  it('degrades to unavailable:true if the SECOND candidate\'s call is what fails, without losing the first call\'s work', async () => {
    const req = fake_req(
      'POST',
      '/api/ask',
      JSON.stringify({
        mode: 'contradiction',
        question: 'q',
        candidates: [candidate({ segmentId: 's1', text: 'first candidate' }), candidate({ segmentId: 's2', text: 'second candidate' })]
      })
    );
    const res = fake_res();

    let callCount = 0;
    await handle_request(req, res, {
      ollamaGenerate: async () => {
        callCount += 1;
        if (callCount === 1) return { unavailable: false, response: 'no, they agree.' };
        return { unavailable: true };
      }
    });

    expect(callCount).toBe(2);
    expect(JSON.parse(res.body)).toEqual({ ok: true, unavailable: true, text: null });
  });
});

describe('POST /api/ask — freeform', () => {
  it('answers strictly over the retrieved candidates, in chronological order', async () => {
    const req = fake_req(
      'POST',
      '/api/ask',
      JSON.stringify({
        mode: 'freeform',
        question: 'who proposed the museum funding?',
        candidates: [
          candidate({ segmentId: 's2', speaker: 'R', tStart: 20, text: 'later remark' }),
          candidate({ segmentId: 's1', speaker: 'L', tStart: 5, text: 'earlier remark' })
        ]
      })
    );
    const res = fake_res();

    let capturedPrompt = null;
    await handle_request(req, res, {
      ollamaGenerate: async ({ prompt }) => {
        capturedPrompt = prompt;
        return { unavailable: false, response: 'Based on the transcript, L proposed it first.' };
      }
    });

    expect(capturedPrompt.indexOf('earlier remark')).toBeLessThan(capturedPrompt.indexOf('later remark'));
    expect(capturedPrompt).toContain('ONLY the transcript excerpts');
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      unavailable: false,
      text: 'Based on the transcript, L proposed it first.'
    });
  });

  it('still produces a valid (honest) prompt with zero candidates, and degrades cleanly when Ollama is down', async () => {
    const req = fake_req('POST', '/api/ask', JSON.stringify({ mode: 'freeform', question: 'q', candidates: [] }));
    const res = fake_res();

    await handle_request(req, res, { ollamaGenerate: async () => ({ unavailable: true }) });

    expect(JSON.parse(res.body)).toEqual({ ok: true, unavailable: true, text: null });
  });
});

describe('POST /api/ask — abort kills the upstream Ollama request', () => {
  let stub;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
  });

  it('destroys the in-flight request on the real upstream when the client (res) closes the connection', async () => {
    let handlerEntered = false;
    let sawAbortedOrClose = false;
    let markSeen;
    const seenPromise = new Promise((resolve) => {
      markSeen = resolve;
    });

    const realServer = createServer((httpReq, httpRes) => {
      let raw = '';
      httpReq.on('data', (c) => (raw += c));
      httpReq.on('end', () => {
        // Never respond — this request is what's in flight when the
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
      '/api/ask',
      JSON.stringify({ mode: 'freeform', question: 'q', candidates: [candidate({})], model: 'real-model' })
    );
    const res = fake_res();

    const handlerPromise = handle_request(req, res, {
      ollamaGenerate: ({ model, prompt, signal, stream }) =>
        ollama_generate({ model, prompt, baseUrl: stub.baseUrl, signal, stream })
    });

    // Give the request a moment to actually reach the stub before aborting.
    await new Promise((r) => setTimeout(r, 50));
    res.emit('close');
    await handlerPromise;

    await Promise.race([seenPromise, new Promise((r) => setTimeout(r, 1000))]);
    expect(handlerEntered).toBe(true);
    expect(sawAbortedOrClose).toBe(true);
    expect(res.writableEnded).toBe(false); // the handler returned early, no send_json ever ran
  });
});
