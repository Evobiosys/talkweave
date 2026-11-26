// SPDX-License-Identifier: AGPL-3.0-or-later

// Host/Origin guard for the loopback API server.
//
// Binding to 127.0.0.1 alone does not stop a web page from reaching this
// server (DNS rebinding, or a plain cross-origin fetch to 127.0.0.1), so every
// request is checked before it reaches the router:
//
//   1. Host must be 127.0.0.1 or localhost (bare, or with the configured port).
//      Anything else (a rebound attacker hostname) -> 421. The desktop shell's
//      health check sends a bare `Host: 127.0.0.1`, hence the bare form.
//   2. No Origin header (curl, same-origin GET, the Tauri health check) -> allowed.
//   3. The server's own origins (http://127.0.0.1:PORT, http://localhost:PORT;
//      the Tauri window loads the former) -> allowed on every path.
//   4. EXTRA_ORIGINS -> allowed ONLY on EXTRA_ORIGIN_PATHS, with CORS headers.
//   5. Any other Origin (including the literal `null`) -> 403.
//
// DECISION 2026-10-05 (Jakob, TrustWeb demo session): TalkWeave may be reached
// from the live TrustWeb site so it can transcribe meetings through a local
// TalkWeave. Exactly ONE extra origin and exactly the two path families the
// TrustWeb dev proxy already exposes. Do not widen this list without a new
// decision; TALKWEAVE_EXTRA_ORIGINS (comma separated, exact origins) replaces
// it for local experiments and is never a code default.

/** The single extra origin allowed to call the paths below. */
export const EXTRA_ORIGINS = Object.freeze(['https://app.idea2.site']);

/** Exact pathnames and pathname prefixes the extra origins may reach. */
export const EXTRA_ORIGIN_PATHS = Object.freeze({
  exact: Object.freeze(['/api/whisper/available']),
  prefixes: Object.freeze(['/api/mic/'])
});

const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'Content-Type';
const CORS_MAX_AGE_SECONDS = '600';
const LOOPBACK_HOSTNAMES = Object.freeze(['127.0.0.1', 'localhost']);

/**
 * @typedef {{ port: number; extraOrigins: readonly string[] }} GuardConfig
 * @typedef {{ allow: true; headers: Record<string, string>; preflight: boolean }
 *   | { allow: false; status: 403 | 421; error: string }} GuardDecision
 */

/**
 * Parses TALKWEAVE_EXTRA_ORIGINS. Only exact `http(s)://host[:port]` origins
 * survive: no wildcard, no `null`, no path, no credentials.
 * @param {string | undefined} raw
 * @returns {readonly string[]}
 */
export function parse_extra_origins(raw) {
  if (raw === undefined) return EXTRA_ORIGINS;
  /** @type {string[]} */
  const origins = [];
  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (!candidate) continue;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (url.origin !== candidate) continue; // rejects paths, trailing slash, credentials, case tricks
    origins.push(url.origin);
  }
  return origins;
}

/**
 * @param {string | undefined} hostHeader
 * @param {number} port
 * @returns {boolean}
 */
export function is_allowed_host(hostHeader, port) {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  return LOOPBACK_HOSTNAMES.some((name) => host === name || host === `${name}:${port}`);
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
export function is_extra_origin_path(pathname) {
  return (
    EXTRA_ORIGIN_PATHS.exact.includes(pathname) ||
    EXTRA_ORIGIN_PATHS.prefixes.some((prefix) => pathname.startsWith(prefix) && pathname.length > prefix.length)
  );
}

/**
 * Pure decision: no I/O, no req/res. The pathname is computed exactly the way
 * router.mjs computes it, so `..` and `%2e%2e` segments cannot make the guard
 * and the router disagree about which route a request hits.
 * @param {{ host?: string; origin?: string; method?: string; url?: string; preflightPrivateNetwork?: boolean }} request
 * @param {GuardConfig} config
 * @returns {GuardDecision}
 */
export function decide(request, config) {
  if (!is_allowed_host(request.host, config.port)) {
    return { allow: false, status: 421, error: 'host_not_allowed' };
  }
  const { origin } = request;
  if (origin === undefined) return { allow: true, headers: {}, preflight: false };

  const own = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`];
  if (own.includes(origin)) return { allow: true, headers: {}, preflight: false };

  if (!config.extraOrigins.includes(origin)) {
    return { allow: false, status: 403, error: 'origin_not_allowed' };
  }
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!is_extra_origin_path(pathname)) {
    return { allow: false, status: 403, error: 'origin_not_allowed' };
  }

  /** @type {Record<string, string>} */
  const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const preflight = request.method === 'OPTIONS';
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = CORS_METHODS;
    headers['Access-Control-Allow-Headers'] = CORS_HEADERS;
    headers['Access-Control-Max-Age'] = CORS_MAX_AGE_SECONDS;
    if (request.preflightPrivateNetwork) headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return { allow: true, headers, preflight };
}

/**
 * @param {import('node:http').IncomingMessage['headers'][string]} value
 * @returns {string | undefined}
 */
function single_header(value) {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Builds the request wrapper. Returns true when the request was answered here
 * (denied, or a CORS preflight) and must not reach the router. For an allowed
 * cross-origin request the CORS headers are set with `res.setHeader`, which
 * Node merges into any later `writeHead`, so the SSE stream and every JSON
 * error path carry them without the router knowing about CORS.
 * @param {GuardConfig} config
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 */
export function create_guard(config) {
  return (req, res) => {
    const decision = decide(
      {
        host: single_header(req.headers.host),
        origin: single_header(req.headers.origin),
        method: req.method,
        url: req.url,
        preflightPrivateNetwork: single_header(req.headers['access-control-request-private-network']) === 'true'
      },
      config
    );
    if (!decision.allow) {
      const payload = JSON.stringify({ ok: false, error: decision.error });
      res.writeHead(decision.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
      return true;
    }
    for (const [name, value] of Object.entries(decision.headers)) res.setHeader(name, value);
    if (decision.preflight) {
      res.writeHead(204, { 'Content-Length': 0 });
      res.end();
      return true;
    }
    return false;
  };
}
