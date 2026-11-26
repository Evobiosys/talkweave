// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  asr_proxy_run,
  check_asr_proxy_availability,
  resolve_asr_proxy_url,
  resolve_asr_upstream_url,
  strip_asr_tags,
  DEFAULT_ASR_MODEL
} from '../server/lib/qwen_asr.mjs';

/** Builds a minimal fetch-shaped Response stand-in. `jsonImpl` defaults to
 *  rejecting (a body that never gets read in that test path). */
function fake_response({ ok = true, jsonImpl } = {}) {
  return {
    ok,
    json: jsonImpl ?? (async () => { throw new Error('no json in this fixture'); })
  };
}

/** A `fetchImpl` that never resolves on its own — only reacts to the
 *  request's AbortSignal firing, the way real `fetch` does when its
 *  controller aborts mid-flight. Used to exercise the timeout watchdog
 *  without a real network wait. */
function hanging_fetch_impl() {
  return (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

describe('resolve_asr_proxy_url', () => {
  it('defaults to http://127.0.0.1:8001 with no env override', () => {
    expect(resolve_asr_proxy_url({})).toBe('http://127.0.0.1:8001');
  });
  it('honors ASR_PROXY_URL, trimmed', () => {
    expect(resolve_asr_proxy_url({ ASR_PROXY_URL: '  http://127.0.0.1:9001  ' })).toBe('http://127.0.0.1:9001');
  });
  it('ignores an empty/whitespace-only override', () => {
    expect(resolve_asr_proxy_url({ ASR_PROXY_URL: '   ' })).toBe('http://127.0.0.1:8001');
  });
});

describe('resolve_asr_upstream_url', () => {
  it('defaults to http://127.0.0.1:8000 with no env override', () => {
    expect(resolve_asr_upstream_url({})).toBe('http://127.0.0.1:8000');
  });
  it('honors ASR_UPSTREAM_URL, trimmed', () => {
    expect(resolve_asr_upstream_url({ ASR_UPSTREAM_URL: '  http://127.0.0.1:9000  ' })).toBe('http://127.0.0.1:9000');
  });
});

describe('strip_asr_tags', () => {
  it('strips wrapping <asr_text> tags', () => {
    expect(strip_asr_tags('<asr_text>hello there</asr_text>')).toBe('hello there');
  });
  it('is a no-op on plain text', () => {
    expect(strip_asr_tags('hello there')).toBe('hello there');
  });
  it('trims surrounding whitespace left behind after stripping', () => {
    expect(strip_asr_tags('  <asr_text> hi </asr_text>  ')).toBe('hi');
  });
});

describe('asr_proxy_run', () => {
  it('posts multipart/form-data with the wav bytes and model, and returns the response text', async () => {
    let capturedForm;
    const fetchImpl = async (url, opts) => {
      expect(String(url)).toBe('http://127.0.0.1:8001/v1/audio/transcriptions');
      expect(opts.method).toBe('POST');
      capturedForm = opts.body;
      return fake_response({ jsonImpl: async () => ({ text: 'hallo welt' }) });
    };

    const result = await asr_proxy_run(Buffer.from('fake-wav-bytes'), { fetchImpl });

    expect(result).toBe('hallo welt');
    expect(capturedForm.get('model')).toBe(DEFAULT_ASR_MODEL);
    const file = capturedForm.get('file');
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
  });

  it('honors an explicit model override', async () => {
    let capturedForm;
    const fetchImpl = async (_url, opts) => {
      capturedForm = opts.body;
      return fake_response({ jsonImpl: async () => ({ text: 'x' }) });
    };
    await asr_proxy_run(Buffer.from('x'), { fetchImpl, model: 'qwen3-asr-large' });
    expect(capturedForm.get('model')).toBe('qwen3-asr-large');
  });

  it('strips <asr_text> tags from the returned text', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => ({ text: '<asr_text>servus</asr_text>' }) });
    expect(await asr_proxy_run(Buffer.from('x'), { fetchImpl })).toBe('servus');
  });

  it('resolves empty string for a non-2xx response', async () => {
    const fetchImpl = async () => fake_response({ ok: false });
    expect(await asr_proxy_run(Buffer.from('x'), { fetchImpl })).toBe('');
  });

  it('resolves empty string for a malformed (non-JSON) body', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => { throw new SyntaxError('bad json'); } });
    expect(await asr_proxy_run(Buffer.from('x'), { fetchImpl })).toBe('');
  });

  it('resolves empty string when the parsed body has no text field', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => ({ done: true }) });
    expect(await asr_proxy_run(Buffer.from('x'), { fetchImpl })).toBe('');
  });

  it('resolves empty string when text is present but empty', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => ({ text: '' }) });
    expect(await asr_proxy_run(Buffer.from('x'), { fetchImpl })).toBe('');
  });

  it('resolves empty string on a network-level rejection', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    expect(await asr_proxy_run(Buffer.from('x'), { fetchImpl })).toBe('');
  });

  it('resolves empty string once the timeout watchdog fires, never hanging the test', async () => {
    const result = await asr_proxy_run(Buffer.from('x'), { fetchImpl: hanging_fetch_impl(), timeoutMs: 20 });
    expect(result).toBe('');
  });

  it('resolves empty string for a malformed baseUrl rather than throwing', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => ({ text: 'unreachable' }) });
    expect(await asr_proxy_run(Buffer.from('x'), { fetchImpl, baseUrl: 'not a url' })).toBe('');
  });
});

describe('check_asr_proxy_availability', () => {
  it('reports available:true, modelPresent:true when the upstream lists the target model', async () => {
    const fetchImpl = async (url) => {
      expect(String(url)).toBe('http://127.0.0.1:8000/v1/models');
      return fake_response({ jsonImpl: async () => ({ data: [{ id: 'qwen3-asr' }] }) });
    };
    const status = await check_asr_proxy_availability({ fetchImpl });
    expect(status).toEqual({ available: true, bin: 'http://127.0.0.1:8001', model: DEFAULT_ASR_MODEL, modelPresent: true });
  });

  it('reports bin as the PROXY url even though the probe itself targets the upstream', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => ({ data: [{ id: 'qwen3-asr' }] }) });
    const status = await check_asr_proxy_availability({ fetchImpl, baseUrl: 'http://127.0.0.1:9001', upstreamUrl: 'http://127.0.0.1:9000' });
    expect(status.bin).toBe('http://127.0.0.1:9001');
  });

  it('reports modelPresent:false when the upstream is reachable but does not list the target model', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => ({ data: [{ id: 'some-other-model' }] }) });
    const status = await check_asr_proxy_availability({ fetchImpl });
    expect(status).toEqual({ available: true, bin: 'http://127.0.0.1:8001', model: DEFAULT_ASR_MODEL, modelPresent: false });
  });

  it('reports modelPresent:true when the 200 body is unparseable — reachable is reachable', async () => {
    const fetchImpl = async () => fake_response({ jsonImpl: async () => { throw new SyntaxError('bad json'); } });
    const status = await check_asr_proxy_availability({ fetchImpl });
    expect(status.available).toBe(true);
    expect(status.modelPresent).toBe(true);
  });

  it('reports unavailable on a non-2xx response', async () => {
    const fetchImpl = async () => fake_response({ ok: false });
    const status = await check_asr_proxy_availability({ fetchImpl });
    expect(status).toEqual({ available: false, bin: 'http://127.0.0.1:8001', model: DEFAULT_ASR_MODEL, modelPresent: false });
  });

  it('reports unavailable when nothing answers (network rejection)', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const status = await check_asr_proxy_availability({ fetchImpl });
    expect(status).toEqual({ available: false, bin: 'http://127.0.0.1:8001', model: DEFAULT_ASR_MODEL, modelPresent: false });
  });

  it('reports unavailable once the probe timeout fires, never hanging the test', async () => {
    const status = await check_asr_proxy_availability({ fetchImpl: hanging_fetch_impl(), timeoutMs: 20 });
    expect(status.available).toBe(false);
  });
});
