// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { handle_request } from '../server/lib/router.mjs';

/** Same fake req/res pattern as session_routes.test.mjs. */
function fake_req(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

function fake_res() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: null,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    get body() {
      return Buffer.concat(chunks).toString('utf-8');
    }
  };
  return res;
}

function seg(id, speaker, tStart, tEnd, text, final = true) {
  return { id, speaker, tStart, tEnd, text, final };
}

describe('POST /api/llm/claim', () => {
  it('returns a via:"llm" result when the stubbed model returns a valid verbatim substring', async () => {
    const context = [seg('s1', 'R', 0, 3, 'I believe rent control actually helps tenants.')];
    const req = fake_req(
      'POST',
      '/api/llm/claim',
      JSON.stringify({ context, flagT: 5, principles: 'focus on economics' })
    );
    const res = fake_res();

    let capturedPrompt = null;
    await handle_request(req, res, {
      ollamaGenerate: async ({ model, prompt }) => {
        capturedPrompt = prompt;
        expect(model).toBe('qwen3:4b');
        return { unavailable: false, response: '"rent control actually helps tenants"' };
      }
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toEqual({
      ok: true,
      claim: 'rent control actually helps tenants',
      segmentId: 's1',
      charStart: 10,
      charEnd: 45,
      via: 'llm',
      ollamaAvailable: true
    });
    expect(capturedPrompt).toContain('focus on economics');
  });

  it('honors an explicit model field from the request body', async () => {
    const context = [seg('s1', 'R', 0, 3, 'text here')];
    const req = fake_req('POST', '/api/llm/claim', JSON.stringify({ context, flagT: 5, model: 'custom-model' }));
    const res = fake_res();

    let capturedModel = null;
    await handle_request(req, res, {
      ollamaGenerate: async ({ model }) => {
        capturedModel = model;
        return { unavailable: true };
      }
    });

    expect(capturedModel).toBe('custom-model');
    expect(res.statusCode).toBe(200);
  });

  it('falls back to sentence extraction when the model response does not validate as a substring', async () => {
    const context = [seg('s1', 'R', 0, 3, 'A real point. The actual sentence to fall back to.')];
    const req = fake_req('POST', '/api/llm/claim', JSON.stringify({ context, flagT: 5 }));
    const res = fake_res();

    await handle_request(req, res, {
      ollamaGenerate: async () => ({ unavailable: false, response: 'a completely unrelated hallucinated claim' })
    });

    const data = JSON.parse(res.body);
    expect(data.via).toBe('fallback');
    expect(data.ollamaAvailable).toBe(true); // Ollama WAS up — just produced an invalid answer
    expect(data.claim).toBe('The actual sentence to fall back to.');
    expect(data.segmentId).toBe('s1');
  });

  it('falls back and reports ollamaAvailable:false when Ollama is unreachable', async () => {
    const context = [seg('s1', 'R', 0, 3, 'The claim that should be used as fallback.')];
    const req = fake_req('POST', '/api/llm/claim', JSON.stringify({ context, flagT: 5 }));
    const res = fake_res();

    await handle_request(req, res, { ollamaGenerate: async () => ({ unavailable: true }) });

    const data = JSON.parse(res.body);
    expect(data.via).toBe('fallback');
    expect(data.ollamaAvailable).toBe(false);
    expect(data.claim).toBe('The claim that should be used as fallback.');
  });

  it('never calls Ollama and returns ollamaAvailable:null (not true) when there is no eligible other-speaker segment (review fix round 1, Important 4)', async () => {
    const req = fake_req('POST', '/api/llm/claim', JSON.stringify({ context: [], flagT: 5 }));
    const res = fake_res();

    let called = false;
    await handle_request(req, res, {
      ollamaGenerate: async () => {
        called = true;
        return { unavailable: false, response: 'x' };
      }
    });

    expect(called).toBe(false);
    const data = JSON.parse(res.body);
    expect(data).toEqual({
      ok: true,
      claim: null,
      segmentId: null,
      charStart: null,
      charEnd: null,
      via: 'fallback',
      ollamaAvailable: null
    });
  });

  it('returns 400 invalid_body for malformed JSON', async () => {
    const req = fake_req('POST', '/api/llm/claim', 'not json');
    const res = fake_res();
    await handle_request(req, res, {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'invalid_body' });
  });

  it('returns 400 invalid_body when context is missing or flagT is not a number', async () => {
    const res1 = fake_res();
    await handle_request(fake_req('POST', '/api/llm/claim', JSON.stringify({ flagT: 5 })), res1, {});
    expect(res1.statusCode).toBe(400);

    const res2 = fake_res();
    await handle_request(fake_req('POST', '/api/llm/claim', JSON.stringify({ context: [] })), res2, {});
    expect(res2.statusCode).toBe(400);
  });
});

describe('POST /api/llm/summary', () => {
  it('returns a truncated-to-3-bullets summary on success', async () => {
    const segments = [seg('s1', 'L', 0, 10, 'point A'), seg('s2', 'R', 10, 20, 'point B')];
    const req = fake_req('POST', '/api/llm/summary', JSON.stringify({ segments, tFrom: 0, tTo: 20 }));
    const res = fake_res();

    let capturedPrompt = null;
    await handle_request(req, res, {
      ollamaGenerate: async ({ prompt }) => {
        capturedPrompt = prompt;
        return { unavailable: false, response: '- bullet one\n- bullet two\n- bullet three\n- bullet four' };
      }
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toEqual({ ok: true, unavailable: false, text: '- bullet one\n- bullet two\n- bullet three' });
    expect(capturedPrompt).toContain('point A');
    expect(capturedPrompt).toContain('point B');
  });

  it('degrades silently (ok:true, unavailable:true, text:null) when Ollama is down', async () => {
    const req = fake_req('POST', '/api/llm/summary', JSON.stringify({ segments: [], tFrom: 0, tTo: 60 }));
    const res = fake_res();

    await handle_request(req, res, { ollamaGenerate: async () => ({ unavailable: true }) });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, unavailable: true, text: null });
  });

  it('returns 400 invalid_body when segments/tFrom/tTo are missing or malformed', async () => {
    const res1 = fake_res();
    await handle_request(fake_req('POST', '/api/llm/summary', JSON.stringify({ tFrom: 0, tTo: 60 })), res1, {});
    expect(res1.statusCode).toBe(400);

    const res2 = fake_res();
    await handle_request(fake_req('POST', '/api/llm/summary', JSON.stringify({ segments: [], tTo: 60 })), res2, {});
    expect(res2.statusCode).toBe(400);

    const res3 = fake_res();
    await handle_request(fake_req('POST', '/api/llm/summary', 'garbage'), res3, {});
    expect(res3.statusCode).toBe(400);
  });
});
