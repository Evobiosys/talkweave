// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — GET /api/session/:id/export integration test, through the
// real router + a real session.md/audio.webm on disk (tmp dir), same style
// as tests/session_routes.test.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handle_request } from '../server/lib/router.mjs';
import { MAX_AUDIO_EMBED_BYTES } from '../server/lib/export.mjs';

function fake_req(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
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
    get buffer() {
      return Buffer.concat(chunks);
    },
    get body() {
      return Buffer.concat(chunks).toString('utf-8');
    }
  };
  return res;
}

const SESSION_MD = [
  '# Talkweave — Housing pitch',
  'id: 20260101-120000',
  'started: 2026-01-01T12:00:00.000Z',
  'names: L=Jakob R=Alex',
  'audio: audio.webm',
  '',
  '## Transcript',
  '- [0–5] L s1: Styria has about eighteen thousand vacant units.',
  '  - flag f1 @6 by=R source=ai: eighteen thousand vacant units',
  '- [5–8] R s2: That sounds made up.',
  '',
  '## Summaries',
  '',
  '## Fact-checks',
  ''
].join('\n');

let sessionsRoot;
const id = '20260101-120000';

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), 'talkweave-export-routes-'));
  await mkdir(join(sessionsRoot, id), { recursive: true });
  await writeFile(join(sessionsRoot, id, 'session.md'), SESSION_MD);
});

afterEach(async () => {
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe('GET /api/session/:id/export', () => {
  it('404s for an unknown session id', async () => {
    const req = fake_req('GET', '/api/session/20991231-235959/export');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });
    expect(res.statusCode).toBe(404);
  });

  it('400s for a malformed session id', async () => {
    const req = fake_req('GET', '/api/session/not-an-id/export');
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });
    expect(res.statusCode).toBe(400);
  });

  it('renders self-contained HTML with both names and the flagged claim, when there is no audio file', async () => {
    const req = fake_req('GET', `/api/session/${id}/export`);
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain('Jakob');
    expect(res.body).toContain('Alex');
    expect(res.body).toContain('<mark class="flag-mark">Styria has about eighteen thousand vacant units.</mark>');
    // session.md declares `audio: audio.webm` but no audio.webm file exists on disk
    expect(res.body).toContain('No audio was recorded');
  });

  it('embeds audio.webm as base64 when it exists and is under the size cap', async () => {
    const audioBytes = Buffer.from('fake-webm-bytes');
    await writeFile(join(sessionsRoot, id, 'audio.webm'), audioBytes);

    const req = fake_req('GET', `/api/session/${id}/export`);
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`data:audio/webm;base64,${audioBytes.toString('base64')}`);
  });

  it('omits audio with a note when audio.webm is at/over the 25MB cap', async () => {
    const bigAudio = Buffer.alloc(MAX_AUDIO_EMBED_BYTES, 1);
    await writeFile(join(sessionsRoot, id, 'audio.webm'), bigAudio);

    const req = fake_req('GET', `/api/session/${id}/export`);
    const res = fake_res();
    await handle_request(req, res, { sessionsRoot });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('data:audio/webm');
    expect(res.body).toContain('exceeds the 25 MB export limit');
  });
});
