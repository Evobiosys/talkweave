// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handle_request } from '../server/lib/router.mjs';

/**
 * Fake IncomingMessage: a real async-iterable Readable stream (so
 * read_body's `for await` in router.mjs works exactly as it does against a
 * real http.IncomingMessage), with method/url/headers bolted on. `headers`
 * defaults to `{}` (a real `http.IncomingMessage` always has a headers
 * object, even with none sent) so `handle_get_audio`'s `req.headers['range']`
 * read never throws against these fakes.
 */
function fake_req(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

/** Fake ServerResponse that buffers whatever was passed to end(), so both
 *  JSON string bodies and binary (audio) bodies survive intact. */
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

let sessionsRoot;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), 'talkweave-session-routes-'));
});

afterEach(async () => {
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe('POST /api/session', () => {
  it('creates a session and returns its id', async () => {
    const req = fake_req('POST', '/api/session');
    const res = fake_res();

    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.id).toMatch(/^[0-9]{8}-[0-9]{6}$/);

    const md = await readFile(join(sessionsRoot, data.id, 'session.md'), 'utf-8');
    expect(md).toContain(`id: ${data.id}`);
  });

  it('honors a JSON body with title/names', async () => {
    const req = fake_req('POST', '/api/session', JSON.stringify({ title: 'Kickoff', names: { L: 'A', R: 'B' } }));
    const res = fake_res();

    await handle_request(req, res, { sessionsRoot });

    const data = JSON.parse(res.body);
    expect(data.title).toBe('Kickoff');
    const md = await readFile(join(sessionsRoot, data.id, 'session.md'), 'utf-8');
    expect(md).toContain('names: L=A R=B');
  });

  it('falls back to defaults rather than 400ing on a malformed JSON body', async () => {
    const req = fake_req('POST', '/api/session', 'not json{{{');
    const res = fake_res();

    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('500s with a clear error when sessionsRoot is not configured', async () => {
    const req = fake_req('POST', '/api/session');
    const res = fake_res();

    await handle_request(req, res, {});

    expect(res.statusCode).toBe(500);
  });
});

describe('GET /api/sessions', () => {
  it('lists an empty array when no sessions exist yet', async () => {
    const req = fake_req('GET', '/api/sessions');
    const res = fake_res();

    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, sessions: [] });
  });

  it('lists a created session', async () => {
    await handle_request(fake_req('POST', '/api/session', JSON.stringify({ title: 'Chat one' })), fake_res(), {
      sessionsRoot
    });

    const req = fake_req('GET', '/api/sessions');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].title).toBe('Chat one');
  });
});

describe('GET /api/session/:id', () => {
  it('returns the session.md text with a markdown content type', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);

    const req = fake_req('GET', `/api/session/${id}`);
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/markdown');
    expect(res.body).toContain(`id: ${id}`);
  });

  it('404s for a valid-shaped id that does not exist', async () => {
    const req = fake_req('GET', '/api/session/20260101-000000');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'not_found' });
  });

  it('400s for a malformed id', async () => {
    const req = fake_req('GET', '/api/session/not-an-id');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(400);
  });

  it('400s for a path-traversal-shaped id segment, never leaking outside sessionsRoot', async () => {
    const req = fake_req('GET', '/api/session/..%2f..%2fetc%2fpasswd');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/session/:id', () => {
  it('overwrites session.md with the raw body text', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);

    const newMd = `# Talkweave — Edited\nid: ${id}\nstarted: x\nnames: L=a R=b\n\n## Transcript\n\n## Summaries\n\n## Fact-checks\n`;
    const putReq = fake_req('PUT', `/api/session/${id}`, newMd);
    const putRes = fake_res();
    await handle_request(putReq, putRes, { sessionsRoot });

    expect(putRes.statusCode).toBe(200);
    expect(JSON.parse(putRes.body)).toEqual({ ok: true });

    const getReq = fake_req('GET', `/api/session/${id}`);
    const getRes = fake_res();
    await handle_request(getReq, getRes, { sessionsRoot });
    expect(getRes.body).toBe(newMd);
  });

  it('creates the session directory if PUT arrives before POST for that id', async () => {
    const id = '20260101-000000';
    const md = 'seeded content';
    const req = fake_req('PUT', `/api/session/${id}`, md);
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    const readBack = await readFile(join(sessionsRoot, id, 'session.md'), 'utf-8');
    expect(readBack).toBe(md);
  });

  it('400s for a malformed id without writing anything', async () => {
    const req = fake_req('PUT', '/api/session/not-an-id', 'x');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST + GET /api/session/:id/audio', () => {
  it('round-trips raw binary audio bytes', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);

    const audioBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
    const postReq = fake_req('POST', `/api/session/${id}/audio`, audioBytes);
    const postRes = fake_res();
    await handle_request(postReq, postRes, { sessionsRoot });

    expect(postRes.statusCode).toBe(200);
    expect(JSON.parse(postRes.body)).toEqual({ ok: true });

    const getReq = fake_req('GET', `/api/session/${id}/audio`);
    const getRes = fake_res();
    await handle_request(getReq, getRes, { sessionsRoot });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers['Content-Type']).toBe('audio/webm');
    expect(getRes.buffer).toEqual(audioBytes);
  });

  it('GET audio 404s when no audio has been posted yet', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);

    const req = fake_req('GET', `/api/session/${id}/audio`);
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(404);
  });

  it('POST audio 400s for a malformed id', async () => {
    const req = fake_req('POST', '/api/session/not-an-id/audio', Buffer.from([1]));
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(400);
  });

  it('GET audio advertises Accept-Ranges: bytes even on a plain (no Range header) request', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);
    await handle_request(
      fake_req('POST', `/api/session/${id}/audio`, Buffer.alloc(1000, 0xaa)),
      fake_res(),
      { sessionsRoot }
    );

    const res = fake_res();
    await handle_request(fake_req('GET', `/api/session/${id}/audio`), res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Accept-Ranges']).toBe('bytes');
    expect(res.headers['Content-Length']).toBe(1000);
    expect(res.buffer.length).toBe(1000);
  });

  it('GET audio with an explicit Range header returns 206 with exactly the requested bytes', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);
    const fullAudio = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await handle_request(fake_req('POST', `/api/session/${id}/audio`, fullAudio), fake_res(), { sessionsRoot });

    const res = fake_res();
    await handle_request(fake_req('GET', `/api/session/${id}/audio`, undefined, { range: 'bytes=100-199' }), res, {
      sessionsRoot
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe('bytes 100-199/1000');
    expect(res.headers['Accept-Ranges']).toBe('bytes');
    expect(res.headers['Content-Length']).toBe(100);
    expect(res.buffer).toEqual(fullAudio.subarray(100, 200));
  });

  it('GET audio with an open-ended Range header ("bytes=N-") returns the tail of the file', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);
    const fullAudio = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await handle_request(fake_req('POST', `/api/session/${id}/audio`, fullAudio), fake_res(), { sessionsRoot });

    const res = fake_res();
    await handle_request(fake_req('GET', `/api/session/${id}/audio`, undefined, { range: 'bytes=900-' }), res, {
      sessionsRoot
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe('bytes 900-999/1000');
    expect(res.buffer).toEqual(fullAudio.subarray(900, 1000));
  });

  it('GET audio with a suffix Range header ("bytes=-N") returns the last N bytes', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);
    const fullAudio = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await handle_request(fake_req('POST', `/api/session/${id}/audio`, fullAudio), fake_res(), { sessionsRoot });

    const res = fake_res();
    await handle_request(fake_req('GET', `/api/session/${id}/audio`, undefined, { range: 'bytes=-100' }), res, {
      sessionsRoot
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe('bytes 900-999/1000');
    expect(res.buffer).toEqual(fullAudio.subarray(900, 1000));
  });

  it('GET audio 416s an unsatisfiable Range header (past end of file), with Content-Range bytes */size', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);
    await handle_request(
      fake_req('POST', `/api/session/${id}/audio`, Buffer.alloc(1000, 0xaa)),
      fake_res(),
      { sessionsRoot }
    );

    const res = fake_res();
    await handle_request(fake_req('GET', `/api/session/${id}/audio`, undefined, { range: 'bytes=5000-6000' }), res, {
      sessionsRoot
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers['Content-Range']).toBe('bytes */1000');
    expect(res.buffer.length).toBe(0);
  });

  it('GET audio 416s a malformed Range header', async () => {
    const createRes = fake_res();
    await handle_request(fake_req('POST', '/api/session'), createRes, { sessionsRoot });
    const { id } = JSON.parse(createRes.body);
    await handle_request(
      fake_req('POST', `/api/session/${id}/audio`, Buffer.alloc(1000, 0xaa)),
      fake_res(),
      { sessionsRoot }
    );

    const res = fake_res();
    await handle_request(fake_req('GET', `/api/session/${id}/audio`, undefined, { range: 'garbage' }), res, {
      sessionsRoot
    });

    expect(res.statusCode).toBe(416);
  });
});

describe('session routes: unaffected paths still behave as before', () => {
  it('GET /api/health is unaffected by the new dynamic route table', async () => {
    const req = fake_req('GET', '/api/health');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('an unknown /api/* path still 404s JSON, not swallowed by the session pattern table', async () => {
    const req = fake_req('GET', '/api/session'); // no :id segment — must not match the dynamic routes
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'not_found' });
  });
});
