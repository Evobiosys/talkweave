// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request } from 'node:http';
import {
  EXTRA_ORIGINS,
  create_guard,
  decide,
  is_allowed_host,
  parse_extra_origins
} from '../server/lib/origin_guard.mjs';
import { handle_request } from '../server/lib/router.mjs';

const PORT = 8990;
const CONFIG = { port: PORT, extraOrigins: EXTRA_ORIGINS };
const LIVE = 'https://app.idea2.site';

describe('built-in extra origin list', () => {
  it('is exactly the live TrustWeb site', () => {
    expect([...EXTRA_ORIGINS]).toEqual([LIVE]);
  });
});

describe('is_allowed_host', () => {
  const cases = [
    ['127.0.0.1:8990', true],
    ['localhost:8990', true],
    ['LOCALHOST:8990', true],
    ['127.0.0.1', true], // the desktop shell health check sends no port
    ['localhost', true],
    ['127.0.0.1:9999', false],
    ['evil.example.com', false],
    ['evil.example.com:8990', false],
    ['127.0.0.1.evil.example.com:8990', false],
    ['localhost.evil.example.com', false],
    ['localhost.:8990', false],
    ['[::1]:8990', false],
    ['0.0.0.0:8990', false],
    ['', false],
    [undefined, false]
  ];
  it.each(cases)('Host %j -> %s', (host, expected) => {
    expect(is_allowed_host(host, PORT)).toBe(expected);
  });
});

describe('decide: host x origin x path table', () => {
  const OWN_A = `http://127.0.0.1:${PORT}`;
  const OWN_B = `http://localhost:${PORT}`;
  const GOOD = '127.0.0.1:8990';
  // [label, host, origin, method, url, expected status (200 = allowed to the router, 204 = preflight answered)]
  const table = [
    ['no Origin, own host, any path', GOOD, undefined, 'GET', '/api/sessions', 200],
    ['no Origin, bare Host 127.0.0.1 (shell health check)', '127.0.0.1', undefined, 'GET', '/api/health', 200],
    ['no Origin, localhost host', 'localhost:8990', undefined, 'GET', '/api/sessions', 200],
    ['evil Host, no Origin', 'evil.example.com', undefined, 'GET', '/api/health', 421],
    ['evil Host with live Origin', 'evil.example.com', LIVE, 'GET', '/api/whisper/available', 421],
    ['missing Host', undefined, undefined, 'GET', '/api/health', 421],
    ['own origin 127.0.0.1, any path', GOOD, OWN_A, 'POST', '/api/session', 200],
    ['own origin localhost, any path', 'localhost:8990', OWN_B, 'PUT', '/api/session/x', 200],
    ['own origin on the wrong port', GOOD, 'http://127.0.0.1:5173', 'POST', '/api/session', 403],
    ['evil Origin', GOOD, 'https://evil.example.com', 'GET', '/api/whisper/available', 403],
    ['evil Origin on mic', GOOD, 'https://evil.example.com', 'POST', '/api/mic/start', 403],
    ['Origin null', GOOD, 'null', 'GET', '/api/whisper/available', 403],
    ['live Origin, http scheme', GOOD, 'http://app.idea2.site', 'GET', '/api/whisper/available', 403],
    ['live Origin, subdomain', GOOD, 'https://evil.app.idea2.site', 'GET', '/api/whisper/available', 403],
    ['live Origin, availability probe', GOOD, LIVE, 'GET', '/api/whisper/available', 200],
    ['live Origin, mic start', GOOD, LIVE, 'POST', '/api/mic/start', 200],
    ['live Origin, mic audio', GOOD, LIVE, 'POST', '/api/mic/audio/abc', 200],
    ['live Origin, mic SSE stream', GOOD, LIVE, 'GET', '/api/mic/stream/abc', 200],
    ['live Origin, mic flush', GOOD, LIVE, 'POST', '/api/mic/flush/abc', 200],
    ['live Origin, mic stop', GOOD, LIVE, 'POST', '/api/mic/stop/abc', 200],
    ['live Origin, query string on allowed path', GOOD, LIVE, 'GET', '/api/whisper/available?x=1', 200],
    ['live Origin, sessions list', GOOD, LIVE, 'GET', '/api/sessions', 403],
    ['live Origin, one session', GOOD, LIVE, 'GET', '/api/session/abc', 403],
    ['live Origin, create session', GOOD, LIVE, 'POST', '/api/session', 403],
    ['live Origin, llm', GOOD, LIVE, 'POST', '/api/llm/claim', 403],
    ['live Origin, ask', GOOD, LIVE, 'POST', '/api/ask', 403],
    ['live Origin, factcheck', GOOD, LIVE, 'POST', '/api/factcheck', 403],
    ['live Origin, health', GOOD, LIVE, 'GET', '/api/health', 403],
    ['live Origin, static root', GOOD, LIVE, 'GET', '/', 403],
    ['live Origin, landing', GOOD, LIVE, 'GET', '/landing', 403],
    ['live Origin, mic prefix without a route', GOOD, LIVE, 'GET', '/api/mic/', 403],
    ['live Origin, sibling prefix /api/microphone', GOOD, LIVE, 'GET', '/api/microphone/x', 403],
    ['live Origin, dot-dot escape', GOOD, LIVE, 'GET', '/api/mic/../sessions', 403],
    ['live Origin, encoded dot-dot escape', GOOD, LIVE, 'GET', '/api/mic/%2e%2e/sessions', 403],
    ['live Origin, mixed-case encoded dot-dot', GOOD, LIVE, 'GET', '/api/mic/%2E%2E/session/abc', 403],
    ['live Origin, availability sub-path', GOOD, LIVE, 'GET', '/api/whisper/available/x', 403],
    ['live Origin, absolute-form URL to another route', GOOD, LIVE, 'GET', 'http://x/api/sessions', 403],
    ['live Origin, protocol-relative URL', GOOD, LIVE, 'GET', '//evil.example.com/api/mic/start', 200],
    ['live preflight on mic', GOOD, LIVE, 'OPTIONS', '/api/mic/audio/abc', 204],
    ['live preflight on availability', GOOD, LIVE, 'OPTIONS', '/api/whisper/available', 204],
    ['live preflight on sessions', GOOD, LIVE, 'OPTIONS', '/api/sessions', 403],
    ['evil preflight on mic', GOOD, 'https://evil.example.com', 'OPTIONS', '/api/mic/start', 403]
  ];

  it.each(table)('%s', (_label, host, origin, method, url, expected) => {
    const decision = decide({ host, origin, method, url }, CONFIG);
    if (expected === 200) {
      expect(decision.allow).toBe(true);
      expect(decision.preflight).toBe(false);
    } else if (expected === 204) {
      expect(decision.allow).toBe(true);
      expect(decision.preflight).toBe(true);
    } else {
      expect(decision.allow).toBe(false);
      expect(decision.status).toBe(expected);
    }
  });

  it('adds CORS headers only for the extra origin, never for own or absent origins', () => {
    const own = decide({ host: GOOD, origin: OWN_A, method: 'POST', url: '/api/session' }, CONFIG);
    const none = decide({ host: GOOD, method: 'GET', url: '/api/sessions' }, CONFIG);
    const live = decide({ host: GOOD, origin: LIVE, method: 'POST', url: '/api/mic/start' }, CONFIG);
    expect(own.allow && own.headers).toEqual({});
    expect(none.allow && none.headers).toEqual({});
    expect(live.allow && live.headers).toEqual({ 'Access-Control-Allow-Origin': LIVE, Vary: 'Origin' });
  });

  it('answers Private Network Access only when the preflight asks for it', () => {
    const asked = decide({ host: GOOD, origin: LIVE, method: 'OPTIONS', url: '/api/mic/start', preflightPrivateNetwork: true }, CONFIG);
    const unasked = decide({ host: GOOD, origin: LIVE, method: 'OPTIONS', url: '/api/mic/start' }, CONFIG);
    expect(asked.allow && asked.headers['Access-Control-Allow-Private-Network']).toBe('true');
    expect(unasked.allow && unasked.headers['Access-Control-Allow-Private-Network']).toBeUndefined();
    expect(asked.allow && asked.headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    expect(asked.allow && asked.headers['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('keeps an env-added origin path-restricted exactly like the built-in one', () => {
    const config = { port: PORT, extraOrigins: ['http://127.0.0.1:5195'] };
    const origin = 'http://127.0.0.1:5195';
    expect(decide({ host: GOOD, origin, method: 'GET', url: '/api/whisper/available' }, config).allow).toBe(true);
    expect(decide({ host: GOOD, origin, method: 'POST', url: '/api/mic/start' }, config).allow).toBe(true);
    expect(decide({ host: GOOD, origin, method: 'GET', url: '/api/sessions' }, config).allow).toBe(false);
    // the env list REPLACES the built-in one
    expect(decide({ host: GOOD, origin: LIVE, method: 'GET', url: '/api/whisper/available' }, config).allow).toBe(false);
  });

  it('honours a non-default port for own origins and Host', () => {
    const config = { port: 9123, extraOrigins: EXTRA_ORIGINS };
    expect(decide({ host: '127.0.0.1:9123', origin: 'http://127.0.0.1:9123', method: 'POST', url: '/api/session' }, config).allow).toBe(true);
    expect(decide({ host: '127.0.0.1:8990', method: 'GET', url: '/api/health' }, config).allow).toBe(false);
  });
});

describe('parse_extra_origins', () => {
  it('defaults to the built-in list when the env var is unset', () => {
    expect(parse_extra_origins(undefined)).toEqual([LIVE]);
  });
  it('accepts exact origins and drops wildcards, null, paths, other schemes, and junk', () => {
    expect(parse_extra_origins('http://127.0.0.1:5195, https://a.example')).toEqual(['http://127.0.0.1:5195', 'https://a.example']);
    expect(parse_extra_origins('*')).toEqual([]);
    expect(parse_extra_origins('null')).toEqual([]);
    expect(parse_extra_origins('https://a.example/')).toEqual([]);
    expect(parse_extra_origins('https://a.example/path')).toEqual([]);
    expect(parse_extra_origins('file:///x')).toEqual([]);
    expect(parse_extra_origins('https://user:pw@a.example')).toEqual([]);
    expect(parse_extra_origins('not a url')).toEqual([]);
  });
  it('an empty value switches the extra origin off', () => {
    expect(parse_extra_origins('')).toEqual([]);
  });
});

/**
 * One real node:http server with the guard in front of the real router, like
 * server.mjs wires it, so the CORS headers are asserted on the wire, including
 * on a streaming SSE response.
 */
describe('guard in front of the real router (node:http, port 0)', () => {
  /** @type {import('node:http').Server | undefined} */
  let server;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  /** Guard configured for the canonical port 8990; the socket itself listens on an ephemeral port. */
  async function start() {
    const registry = {
      create: () => 'stream-1',
      has: (id) => id === 'stream-1',
      subscribe: (_id, cb) => {
        setTimeout(() => cb({ text: 'hello', final: false, tStart: 0, tEnd: 1 }), 5);
        return () => {};
      },
      stop: () => true,
      append_audio: () => true,
      flush: async () => true
    };
    const guard = create_guard({ port: PORT, extraOrigins: EXTRA_ORIGINS });
    server = createServer((req, res) => {
      if (guard(req, res)) return;
      handle_request(req, res, {
        micRegistry: registry,
        whisperAvailabilityCheck: () => ({ available: true, bin: 'x', model: 'y', modelPresent: true, engine: 'whisper' })
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  }

  /**
   * @param {number} port
   * @param {{ method?: string; path: string; headers?: Record<string, string>; readUntil?: string }} opts
   * @returns {Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>}
   */
  function call(port, { method = 'GET', path, headers = {}, readUntil }) {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (readUntil && body.includes(readUntil)) {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
            req.destroy();
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
      req.end();
    });
  }

  it('serves the availability probe to the live origin with CORS headers', async () => {
    const port = await start();
    const res = await call(port, { path: '/api/whisper/available', headers: { Host: '127.0.0.1:8990', Origin: LIVE } });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(LIVE);
    expect(res.headers.vary).toBe('Origin');
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, available: true });
  }, 10000);

  it('answers the Private Network Access preflight with 204 and the PNA header', async () => {
    const port = await start();
    const res = await call(port, {
      method: 'OPTIONS',
      path: '/api/mic/start',
      headers: {
        Host: '127.0.0.1:8990',
        Origin: LIVE,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true'
      }
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(LIVE);
    expect(res.headers['access-control-allow-private-network']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
  });

  it('puts the CORS headers on the SSE response', async () => {
    const port = await start();
    const res = await call(port, {
      path: '/api/mic/stream/stream-1',
      headers: { Host: '127.0.0.1:8990', Origin: LIVE },
      readUntil: 'hello'
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe(LIVE);
    expect(res.body).toContain('hello');
  });

  it('puts the CORS headers on a JSON error from an allowed path', async () => {
    const port = await start();
    const res = await call(port, { path: '/api/mic/stream/nope', headers: { Host: '127.0.0.1:8990', Origin: LIVE } });
    expect(res.status).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBe(LIVE);
  });

  it('rejects the live origin on /api/sessions and an evil Host before the router runs', async () => {
    const port = await start();
    const sessions = await call(port, { path: '/api/sessions', headers: { Host: '127.0.0.1:8990', Origin: LIVE } });
    expect(sessions.status).toBe(403);
    expect(sessions.headers['access-control-allow-origin']).toBeUndefined();
    const rebind = await call(port, { path: '/api/health', headers: { Host: 'evil.example.com' } });
    expect(rebind.status).toBe(421);
  });

  it('still serves own-origin and Origin-less requests, bare Host included', async () => {
    const port = await start();
    const bare = await call(port, { path: '/api/health', headers: { Host: '127.0.0.1' } });
    expect(bare.status).toBe(200);
    const own = await call(port, { path: '/api/health', headers: { Host: 'localhost:8990', Origin: 'http://localhost:8990' } });
    expect(own.status).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBeUndefined();
  });
});
