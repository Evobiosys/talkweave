// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle_request, parse_range } from '../server/lib/router.mjs';

/** Minimal fake IncomingMessage. */
function fake_req(method, url) {
  return { method, url };
}

/** Minimal fake ServerResponse that records what was written. */
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

describe('router: GET /api/health', () => {
  it('returns 200 with {ok:true} JSON', async () => {
    const req = fake_req('GET', '/api/health');
    const res = fake_res();

    await handle_request(req, res, {});

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe('router: unknown /api/* path', () => {
  it('returns 404 JSON', async () => {
    const req = fake_req('GET', '/api/does-not-exist');
    const res = fake_res();

    await handle_request(req, res, {});

    expect(res.statusCode).toBe(404);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('router: non-api path with no staticRoot configured', () => {
  it('falls back to 404 JSON rather than throwing', async () => {
    const req = fake_req('GET', '/some/page');
    const res = fake_res();

    await handle_request(req, res, {});

    expect(res.statusCode).toBe(404);
  });
});

describe('router: /api/* paths never fall through to static serving', () => {
  let staticRoot;

  beforeAll(async () => {
    // A populated staticRoot with its own index.html: if /api/* routing were
    // ever to fall through to serve_static's SPA fallback, this would come
    // back as a 200 HTML body instead of a 404 JSON body.
    const workDir = await mkdtemp(join(tmpdir(), 'talkweave-router-'));
    staticRoot = workDir;
    await writeFile(join(staticRoot, 'index.html'), '<html>should never be served for /api</html>');
  });

  afterAll(async () => {
    await rm(staticRoot, { recursive: true, force: true });
  });

  it('still returns JSON 404 for an unknown /api/* path even with a populated staticRoot', async () => {
    const req = fake_req('GET', '/api/does-not-exist');
    const res = fake_res();

    await handle_request(req, res, { staticRoot });

    expect(res.statusCode).toBe(404);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'not_found' });
    expect(res.body).not.toContain('should never be served');
  });

  it('still routes GET /api/health to the health handler, not static, when staticRoot is set', async () => {
    const req = fake_req('GET', '/api/health');
    const res = fake_res();

    await handle_request(req, res, { staticRoot });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe('router: GET /api/whisper/available', () => {
  it('v0.2: reports the full {available, bin, model, modelPresent} shape from the injected check', async () => {
    const req = fake_req('GET', '/api/whisper/available');
    const res = fake_res();

    await handle_request(req, res, {
      whisperAvailabilityCheck: () => ({ available: true, bin: 'whisper-cli', model: '/models/ggml-base.bin', modelPresent: true })
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      available: true,
      bin: 'whisper-cli',
      model: '/models/ggml-base.bin',
      modelPresent: true
    });
  });

  it('reports available:false when the injected check reports the binary missing', async () => {
    const req = fake_req('GET', '/api/whisper/available');
    const res = fake_res();

    await handle_request(req, res, {
      whisperAvailabilityCheck: () => ({ available: false, bin: 'whisper-cli', model: '/models/ggml-base.bin', modelPresent: false })
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(false);
  });

  it('reports available:true but modelPresent:false when the binary is found but the model file is not — the "install one-liner ran, model download did not" state', async () => {
    const req = fake_req('GET', '/api/whisper/available');
    const res = fake_res();

    await handle_request(req, res, {
      whisperAvailabilityCheck: () => ({ available: true, bin: 'whisper-cli', model: '/models/ggml-base.bin', modelPresent: false })
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      available: true,
      bin: 'whisper-cli',
      model: '/models/ggml-base.bin',
      modelPresent: false
    });
  });

  it('v0.3: passes through an `engine` field from the injected check (qwen-asr-engine handover, asr_engine.mjs) alongside the original shape', async () => {
    const req = fake_req('GET', '/api/whisper/available');
    const res = fake_res();

    await handle_request(req, res, {
      whisperAvailabilityCheck: () => ({ available: true, bin: 'http://127.0.0.1:8001', model: 'qwen3-asr', modelPresent: true, engine: 'qwen' })
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      available: true,
      bin: 'http://127.0.0.1:8001',
      model: 'qwen3-asr',
      modelPresent: true,
      engine: 'qwen'
    });
  });

  it('v0.3: awaits an async injected check (asr_engine.mjs\'s checkAvailability re-probes over the network, so it is always async)', async () => {
    const req = fake_req('GET', '/api/whisper/available');
    const res = fake_res();

    await handle_request(req, res, {
      whisperAvailabilityCheck: async () => ({ available: false, bin: 'http://127.0.0.1:8001', model: 'qwen3-asr', modelPresent: false, engine: 'none' })
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(false);
    expect(body.engine).toBe('none');
  });

  it('falls back to the real check_whisper_availability (real `which whisper-cli` shell-out + real model-file check) when no check is injected', async () => {
    // Doesn't assert specific values (whisper-cli's/the model's presence
    // depends on the machine running the tests) — only that the real code
    // path runs without throwing and returns a well-formed response.
    const req = fake_req('GET', '/api/whisper/available');
    const res = fake_res();

    await handle_request(req, res, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.available).toBe('boolean');
    expect(typeof body.bin).toBe('string');
    expect(typeof body.model).toBe('string');
    expect(typeof body.modelPresent).toBe('boolean');
  });
});

describe('router: parse_range', () => {
  const SIZE = 1000;

  it('returns null when there is no Range header (caller serves the full body)', () => {
    expect(parse_range(undefined, SIZE)).toBeNull();
    expect(parse_range('', SIZE)).toBeNull();
  });

  it('parses an explicit range', () => {
    expect(parse_range('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
    expect(parse_range('bytes=500-599', SIZE)).toEqual({ start: 500, end: 599 });
  });

  it('parses an open-ended range ("bytes=start-") as start..end-of-resource', () => {
    expect(parse_range('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('parses a suffix range ("bytes=-N") as the last N bytes', () => {
    expect(parse_range('bytes=-500', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('clamps a suffix range longer than the whole resource to the entire resource', () => {
    expect(parse_range('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an explicit end past the resource size down to the last byte', () => {
    expect(parse_range('bytes=990-999999', SIZE)).toEqual({ start: 990, end: 999 });
  });

  it('is unsatisfiable when start is at or past the resource size', () => {
    expect(parse_range('bytes=1000-', SIZE)).toBe('unsatisfiable');
    expect(parse_range('bytes=5000-6000', SIZE)).toBe('unsatisfiable');
  });

  it('is unsatisfiable when end is before start', () => {
    expect(parse_range('bytes=500-100', SIZE)).toBe('unsatisfiable');
  });

  it('is unsatisfiable for a malformed header (wrong unit, garbage, empty bytes=)', () => {
    expect(parse_range('items=0-99', SIZE)).toBe('unsatisfiable');
    expect(parse_range('bytes=abc-def', SIZE)).toBe('unsatisfiable');
    expect(parse_range('bytes=-', SIZE)).toBe('unsatisfiable');
    expect(parse_range('bytes=', SIZE)).toBe('unsatisfiable');
  });

  it('is unsatisfiable for a multi-range request (not assembled into a multipart response)', () => {
    expect(parse_range('bytes=0-10,20-30', SIZE)).toBe('unsatisfiable');
  });

  it('is unsatisfiable for a suffix length of 0 or negative', () => {
    expect(parse_range('bytes=-0', SIZE)).toBe('unsatisfiable');
  });

  it('is unsatisfiable against a zero-size resource regardless of the range requested', () => {
    expect(parse_range('bytes=0-99', 0)).toBe('unsatisfiable');
  });
});
