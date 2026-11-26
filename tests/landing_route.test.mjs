// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — GET /landing and /landing/ route test (task-11-brief.md).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handle_request } from '../server/lib/router.mjs';

function fake_req(method, url) {
  const stream = Readable.from([]);
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

let landingRoot;

beforeAll(async () => {
  landingRoot = await mkdtemp(join(tmpdir(), 'talkweave-landing-'));
  await mkdir(landingRoot, { recursive: true });
  await writeFile(join(landingRoot, 'index.html'), '<!doctype html><title>talkweave</title><body>landing</body>');
});

afterAll(async () => {
  await rm(landingRoot, { recursive: true, force: true });
});

describe('GET /landing', () => {
  it('serves landing/index.html', async () => {
    const req = fake_req('GET', '/landing');
    const res = fake_res();
    await handle_request(req, res, { landingRoot });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain('landing');
  });

  it('also serves it at /landing/', async () => {
    const req = fake_req('GET', '/landing/');
    const res = fake_res();
    await handle_request(req, res, { landingRoot });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('landing');
  });

  it('404s when landingRoot is not configured', async () => {
    const req = fake_req('GET', '/landing');
    const res = fake_res();
    await handle_request(req, res, {});
    expect(res.statusCode).toBe(404);
  });
});
