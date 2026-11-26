// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { dispatch_sse_event, parse_sse_block } from '../app/src/lib/factcheck_client';
import type { FactCheckStreamHandlers } from '../app/src/lib/factcheck_client';

describe('parse_sse_block', () => {
  it('parses a well-formed event/data block', () => {
    expect(parse_sse_block('event: quick\ndata: {"text":"hi"}')).toEqual({ event: 'quick', data: '{"text":"hi"}' });
  });

  it('tolerates field order (data before event)', () => {
    expect(parse_sse_block('data: {"a":1}\nevent: deep')).toEqual({ event: 'deep', data: '{"a":1}' });
  });

  it('returns null for a block missing event or data', () => {
    expect(parse_sse_block('event: quick')).toBeNull();
    expect(parse_sse_block('data: {}')).toBeNull();
    expect(parse_sse_block('')).toBeNull();
  });
});

describe('dispatch_sse_event', () => {
  function handlers(): FactCheckStreamHandlers & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      onQuick: (d) => calls.push(`quick:${JSON.stringify(d)}`),
      onDeepEta: (d) => calls.push(`deep_eta:${JSON.stringify(d)}`),
      onDeep: (d) => calls.push(`deep:${JSON.stringify(d)}`),
      onDone: () => calls.push('done')
    };
  }

  it('routes a valid quick event', () => {
    const h = handlers();
    dispatch_sse_event('quick', JSON.stringify({ text: 'hi', model: 'q', ms: 5 }), h);
    expect(h.calls).toEqual(['quick:{"text":"hi","model":"q","ms":5}']);
  });

  it('routes a valid deep_eta event', () => {
    const h = handlers();
    dispatch_sse_event('deep_eta', JSON.stringify({ etaMs: 40000 }), h);
    expect(h.calls).toEqual(['deep_eta:{"etaMs":40000}']);
  });

  it('routes a valid deep event, defaulting nuance to "" when absent', () => {
    const h = handlers();
    dispatch_sse_event('deep', JSON.stringify({ text: 'a', model: 'd', ms: 1, contradicts: false }), h);
    expect(h.calls).toEqual(['deep:{"text":"a","model":"d","ms":1,"contradicts":false,"nuance":""}']);
  });

  it('routes a valid deep event with an explicit nuance', () => {
    const h = handlers();
    dispatch_sse_event('deep', JSON.stringify({ text: 'a', model: 'd', ms: 1, contradicts: true, nuance: 'because X' }), h);
    expect(h.calls).toEqual(['deep:{"text":"a","model":"d","ms":1,"contradicts":true,"nuance":"because X"}']);
  });

  it('routes a done event regardless of payload', () => {
    const h = handlers();
    dispatch_sse_event('done', '{}', h);
    expect(h.calls).toEqual(['done']);
  });

  it('silently skips malformed JSON data', () => {
    const h = handlers();
    dispatch_sse_event('quick', 'not json {{{', h);
    expect(h.calls).toEqual([]);
  });

  it('silently skips a quick/deep event missing a required field', () => {
    const h = handlers();
    dispatch_sse_event('quick', JSON.stringify({ text: 'hi' }), h); // missing model/ms
    expect(h.calls).toEqual([]);
  });

  it('silently skips an unrecognized event name', () => {
    const h = handlers();
    dispatch_sse_event('mystery', JSON.stringify({ x: 1 }), h);
    expect(h.calls).toEqual([]);
  });

  it('is a no-op when a handler is not provided for the event', () => {
    expect(() => dispatch_sse_event('quick', JSON.stringify({ text: 'hi', model: 'q', ms: 1 }), {})).not.toThrow();
  });
});

describe('start_factcheck_stream (transport)', () => {
  it('never throws when fetch itself rejects (e.g. network error)', async () => {
    const { start_factcheck_stream } = await import('../app/src/lib/factcheck_client');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down')))
    );
    const handle = start_factcheck_stream(
      { question: 'q', context: [], models: { quick: 'q', deep: 'd' } },
      {}
    );
    expect(typeof handle.abort).toBe('function');
    // Give the detached async IIFE a tick to run and swallow the rejection.
    await new Promise((r) => setTimeout(r, 10));
    vi.unstubAllGlobals();
  });
});
