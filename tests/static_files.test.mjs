// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve_static } from '../server/lib/static_files.mjs';

/**
 * Fake ServerResponse that records status/headers and buffers whatever was
 * passed to end(), so binary bodies (e.g. the PNG fixture) survive intact
 * instead of being string-concatenated.
 */
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
    get buffer() {
      return Buffer.concat(chunks);
    },
    get body() {
      return Buffer.concat(chunks).toString('utf-8');
    }
  };
  return res;
}

let workDir;
let staticRoot;
let secretOutsideRoot;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'talkweave-static-'));
  staticRoot = join(workDir, 'dist');
  await mkdir(join(staticRoot, 'assets'), { recursive: true });

  await writeFile(join(staticRoot, 'index.html'), '<html>talkweave index</html>');
  await writeFile(join(staticRoot, 'assets', 'app.js'), 'console.log("app");');
  await writeFile(join(staticRoot, 'assets', 'style.css'), 'body{background:#000}');
  await writeFile(join(staticRoot, 'assets', 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(staticRoot, 'data.xyz'), 'unknown extension body');

  // A file that sits outside staticRoot, used to prove traversal attempts
  // can't reach it.
  secretOutsideRoot = join(workDir, 'secret.txt');
  await writeFile(secretOutsideRoot, 'TOP SECRET, DO NOT SERVE');
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('serve_static: normal file serving + MIME mapping', () => {
  it('serves an existing JS file with the correct MIME type and body', async () => {
    const res = fake_res();
    await serve_static(res, '/assets/app.js', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(res.body).toBe('console.log("app");');
  });

  it('serves an existing CSS file with the correct MIME type', async () => {
    const res = fake_res();
    await serve_static(res, '/assets/style.css', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/css; charset=utf-8');
  });

  it('serves a binary file (PNG) with the correct MIME type and intact bytes', async () => {
    const res = fake_res();
    await serve_static(res, '/assets/pixel.png', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.buffer).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('serves an unmapped extension as application/octet-stream', async () => {
    const res = fake_res();
    await serve_static(res, '/data.xyz', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
    expect(res.body).toBe('unknown extension body');
  });

  it('serves index.html at the root path', async () => {
    const res = fake_res();
    await serve_static(res, '/', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('talkweave index');
  });
});

describe('serve_static: SPA-style index.html fallback', () => {
  it('falls back to index.html for an unknown deep route', async () => {
    const res = fake_res();
    await serve_static(res, '/some/deep/client/route', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('talkweave index');
  });

  it('falls back to index.html when the path is a directory with no index.html of its own', async () => {
    const res = fake_res();
    await serve_static(res, '/assets', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('talkweave index');
  });
});

describe('serve_static: path traversal defense', () => {
  it('does not leak a file outside staticRoot via a single ../ segment', async () => {
    const res = fake_res();
    await serve_static(res, '/../secret.txt', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('TOP SECRET');
    expect(res.body).toContain('talkweave index');
  });

  it('does not leak a file outside staticRoot via a long ../../../ chain', async () => {
    const res = fake_res();
    await serve_static(res, '/../../../../../../../../secret.txt', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('TOP SECRET');
    expect(res.body).toContain('talkweave index');
  });

  it('does not leak a file outside staticRoot via a mixed real-segment + traversal path', async () => {
    const res = fake_res();
    await serve_static(res, '/assets/../../secret.txt', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('treats a literal encoded slash (%2f) as a filename character, not a path separator', async () => {
    // Regression guard: pathname is taken as-is from URL#pathname, where
    // %2f is intentionally left encoded (never decoded to a real "/") by the
    // WHATWG URL parser. Confirms serve_static doesn't itself decode it into
    // a traversal opportunity.
    const res = fake_res();
    await serve_static(res, '/..%2f..%2fsecret.txt', staticRoot);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('TOP SECRET');
  });
});
