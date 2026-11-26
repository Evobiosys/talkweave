// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { parse_ask_response } from '../app/src/lib/ask_client';

describe('parse_ask_response', () => {
  it('passes through a well-formed recall response', () => {
    expect(parse_ask_response({ ok: true, unavailable: false, text: 'yes, same topic.', sameTopic: true })).toEqual({
      ok: true,
      unavailable: false,
      text: 'yes, same topic.',
      sameTopic: true,
      contradicts: undefined
    });
  });

  it('passes through a well-formed contradiction response', () => {
    expect(parse_ask_response({ ok: true, unavailable: false, text: 'they disagree.', contradicts: true })).toEqual({
      ok: true,
      unavailable: false,
      text: 'they disagree.',
      sameTopic: undefined,
      contradicts: true
    });
  });

  it('passes through unavailable: null (never contacted Ollama)', () => {
    expect(parse_ask_response({ ok: true, unavailable: null, text: null })).toEqual({
      ok: true,
      unavailable: null,
      text: null,
      sameTopic: undefined,
      contradicts: undefined
    });
  });

  it('treats ok:false, missing/malformed body, or a non-object as a network-error result', () => {
    const expected = { ok: false, unavailable: true, text: null };
    expect(parse_ask_response({ ok: false })).toEqual(expected);
    expect(parse_ask_response(null)).toEqual(expected);
    expect(parse_ask_response('not an object')).toEqual(expected);
    expect(parse_ask_response({})).toEqual(expected);
  });
});

describe('start_ask (transport)', () => {
  it('never throws when fetch itself rejects (e.g. network error)', async () => {
    const { start_ask } = await import('../app/src/lib/ask_client');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down')))
    );
    const results: unknown[] = [];
    const handle = start_ask({ mode: 'freeform', question: 'q', candidates: [] }, (r) => results.push(r));
    expect(typeof handle.abort).toBe('function');
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toEqual([{ ok: false, unavailable: true, text: null }]);
    vi.unstubAllGlobals();
  });

  it('reports a network-error result for a non-2xx response', async () => {
    const { start_ask } = await import('../app/src/lib/ask_client');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false }))
    );
    const results: unknown[] = [];
    start_ask({ mode: 'freeform', question: 'q', candidates: [] }, (r) => results.push(r));
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toEqual([{ ok: false, unavailable: true, text: null }]);
    vi.unstubAllGlobals();
  });

  it('forwards a well-formed 200 body via parse_ask_response', async () => {
    const { start_ask } = await import('../app/src/lib/ask_client');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, unavailable: false, text: 'an answer' })
        })
      )
    );
    const results: unknown[] = [];
    start_ask({ mode: 'freeform', question: 'q', candidates: [] }, (r) => results.push(r));
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toEqual([{ ok: true, unavailable: false, text: 'an answer', sameTopic: undefined, contradicts: undefined }]);
    vi.unstubAllGlobals();
  });
});
