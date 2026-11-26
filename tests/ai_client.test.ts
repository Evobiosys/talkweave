// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetch_claim, fetch_summary } from '../app/src/lib/ai_client';
import type { Segment } from '../shared/model';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json_response(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body
  } as Response;
}

const seg: Segment = { id: 's1', speaker: 'L', tStart: 0, tEnd: 1, text: 'hi', final: true };

describe('fetch_claim', () => {
  it('POSTs to /api/llm/claim with the given payload and normalizes a successful response', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = url as string;
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return json_response({
        ok: true,
        claim: 'the claim',
        segmentId: 's1',
        charStart: 0,
        charEnd: 5,
        via: 'llm',
        ollamaAvailable: true
      });
    }) as typeof fetch;

    const result = await fetch_claim({ context: [seg], flagT: 3, principles: 'p', model: 'qwen3:4b' });

    expect(capturedUrl).toBe('/api/llm/claim');
    expect(capturedBody).toEqual({ context: [seg], flagT: 3, principles: 'p', model: 'qwen3:4b' });
    expect(result).toEqual({
      claim: 'the claim',
      segmentId: 's1',
      charStart: 0,
      charEnd: 5,
      via: 'llm',
      ollamaAvailable: true
    });
  });

  it('returns null when the server responds non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => json_response({}, false)) as typeof fetch;
    const result = await fetch_claim({ context: [], flagT: 1 });
    expect(result).toBeNull();
  });

  it('returns null when the response body has ok !== true', async () => {
    globalThis.fetch = vi.fn(async () => json_response({ ok: false })) as typeof fetch;
    const result = await fetch_claim({ context: [], flagT: 1 });
    expect(result).toBeNull();
  });

  it('returns null on a network error rather than throwing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await fetch_claim({ context: [], flagT: 1 });
    expect(result).toBeNull();
  });

  it('normalizes a missing/undefined ollamaAvailable to null, NOT true (review fix round 1, Important 4)', async () => {
    globalThis.fetch = vi.fn(async () =>
      json_response({ ok: true, claim: null, segmentId: null, charStart: null, charEnd: null, via: 'fallback' })
    ) as typeof fetch;
    const result = await fetch_claim({ context: [], flagT: 1 });
    expect(result?.ollamaAvailable).toBeNull();
  });

  it('passes through an explicit ollamaAvailable:true', async () => {
    globalThis.fetch = vi.fn(async () =>
      json_response({
        ok: true,
        claim: 'x',
        segmentId: 's1',
        charStart: 0,
        charEnd: 1,
        via: 'llm',
        ollamaAvailable: true
      })
    ) as typeof fetch;
    const result = await fetch_claim({ context: [], flagT: 1 });
    expect(result?.ollamaAvailable).toBe(true);
  });

  it('passes through an explicit ollamaAvailable:false', async () => {
    globalThis.fetch = vi.fn(async () =>
      json_response({ ok: true, claim: null, segmentId: null, charStart: null, charEnd: null, via: 'fallback', ollamaAvailable: false })
    ) as typeof fetch;
    const result = await fetch_claim({ context: [], flagT: 1 });
    expect(result?.ollamaAvailable).toBe(false);
  });

  it('normalizes an explicit ollamaAvailable:null to null', async () => {
    globalThis.fetch = vi.fn(async () =>
      json_response({
        ok: true,
        claim: null,
        segmentId: null,
        charStart: null,
        charEnd: null,
        via: 'fallback',
        ollamaAvailable: null
      })
    ) as typeof fetch;
    const result = await fetch_claim({ context: [], flagT: 1 });
    expect(result?.ollamaAvailable).toBeNull();
  });
});

describe('fetch_summary', () => {
  it('POSTs to /api/llm/summary and normalizes a successful response', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrl = url as string;
      return json_response({ ok: true, unavailable: false, text: '- a\n- b' });
    }) as typeof fetch;

    const result = await fetch_summary({ segments: [seg], tFrom: 0, tTo: 60 });
    expect(capturedUrl).toBe('/api/llm/summary');
    expect(result).toEqual({ unavailable: false, text: '- a\n- b' });
  });

  it('returns null on a network error rather than throwing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await fetch_summary({ segments: [], tFrom: 0, tTo: 60 });
    expect(result).toBeNull();
  });

  it('surfaces unavailable:true with text:null when Ollama is down', async () => {
    globalThis.fetch = vi.fn(async () => json_response({ ok: true, unavailable: true, text: null })) as typeof fetch;
    const result = await fetch_summary({ segments: [], tFrom: 0, tTo: 60 });
    expect(result).toEqual({ unavailable: true, text: null });
  });
});
