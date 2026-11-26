// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — thin Ollama client (Task 9). Talks only to
// `http://127.0.0.1:11434` (global-constraints.md's local-only rule) via
// node:http — no fetch/undici dependency, matching every other server
// module's "Node stdlib only" constraint. `baseUrl` is an injection seam
// so tests point this at an ephemeral-port stub http server instead of the
// real Ollama daemon (router.mjs's `whisperCheck` option is the precedent
// for this style of seam).
//
// Contract: NEVER throws. A network-level failure (connection refused, DNS
// failure, or the connect timeout below firing before any response
// headers arrive) resolves `{ unavailable: true }` — callers (the
// claim/summary route handlers) treat this as "Ollama is down" and
// degrade accordingly (task-9-brief.md's "silent no-op ... chip" rule). A
// response that DID arrive but can't be parsed as JSON (a malformed/
// garbage body) is NOT treated as `unavailable` — Ollama answered, just
// with something unusable — so it resolves `{ unavailable: false, response:
// '' }` instead; callers validating the (empty) response text naturally
// fall through to their own fallback path without conflating a
// live-but-confused Ollama with a genuinely offline one.
//
// Timeout scope: the timer only bounds how long it takes for response
// HEADERS to arrive (proof Ollama is reachable and responding at all) — it
// is cleared the moment the `response` callback fires, so a slow
// generation (a real, possibly multi-second LLM completion) is never
// mistaken for "unavailable." Only the connect/first-byte phase is
// time-boxed, per task-9-brief.md's literal "1.5s connect timeout."
//
// Abort support (Task 10): an optional `signal` (a standard `AbortSignal`,
// e.g. from `new AbortController()`) lets a caller kill an in-flight
// request — task-10-brief.md's fact-check dismiss/pause requirement
// ("client can abort ... server kills in-flight ollama requests"). Firing
// the signal destroys the underlying `http.ClientRequest` (which, same as
// the connect-timeout path, tears down the TCP connection the upstream
// Ollama/stub server is holding open — this is what "the upstream stub
// sees the abort" tests actually observe) and resolves `{ unavailable:
// true }`, same shape as every other failure path in this module. Already
// aborted at call time resolves immediately without ever calling
// `http.request` at all. The listener is always removed once this
// promise settles (whichever path settles it), so a long-lived
// `AbortController` reused across several `ollama_generate` calls (this
// module's own contradiction-check call reuses the same controller as the
// quick/deep calls — see server/lib/router.mjs) never accumulates stale
// listeners.

import http from 'node:http';

// `TALKWEAVE_OLLAMA_BASE_URL` is a dev/test-only escape hatch (still
// local-only by convention, same as every other address this app talks
// to — nothing in the codebase sets it to anything but a 127.0.0.1 URL):
// it lets `node server/server.mjs` be pointed at a stubbed Ollama for a
// real end-to-end smoke run when the real local Ollama daemon is
// unavailable/unresponsive, without touching the hardcoded default any
// caller relies on. Every call site can still override `baseUrl` directly
// (the `options.baseUrl` parameter below) — this only changes what "no
// override given" resolves to.
const DEFAULT_BASE_URL = process.env.TALKWEAVE_OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
export const CONNECT_TIMEOUT_MS = 1500;

/**
 * @typedef {{ unavailable: boolean; response?: string }} OllamaResult
 */

/**
 * Calls Ollama's `/api/generate`. Non-streaming by default (`stream:
 * false` — Ollama returns one JSON object whose `response` field is
 * already the full text); pass `stream: true` to instead read the
 * newline-delimited-JSON stream Ollama sends in that mode, concatenating
 * every line's `response` field (and, if provided, invoking `onChunk`
 * with each individual token as it arrives). No route in this task
 * actually consumes the streaming mode yet — the client contract itself
 * covers both per task-9-brief.md ("non-stream + stream"), for a later
 * streaming consumer (e.g. Task 10's deep fact-check) to reuse without
 * touching this module.
 *
 * @param {{
 *   model: string;
 *   prompt: string;
 *   stream?: boolean;
 *   baseUrl?: string;
 *   timeoutMs?: number;
 *   onChunk?: (token: string) => void;
 *   signal?: AbortSignal;
 * }} options
 * @returns {Promise<OllamaResult>}
 */
export function ollama_generate(options) {
  const {
    model,
    prompt,
    stream = false,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = CONNECT_TIMEOUT_MS,
    onChunk,
    signal
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    // Declared here (not as the `const connectTimer = setTimeout(...)`
    // below) and only ASSIGNED once the request is actually being made:
    // `finish` can be called before that point (the already-aborted and
    // malformed-`baseUrl` early-return branches below both call it), and a
    // `const` declared further down would still be in its temporal dead
    // zone at that earlier call site, throwing a `ReferenceError` instead
    // of the intended no-op `clearTimeout(undefined)`.
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let connectTimer;
    /** @param {OllamaResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (signal) signal.removeEventListener('abort', on_abort);
      resolve(result);
    };

    const on_abort = () => {
      req?.destroy();
      finish({ unavailable: true });
    };

    if (signal?.aborted) {
      finish({ unavailable: true });
      return;
    }

    /** @type {URL} */
    let target;
    try {
      target = new URL('/api/generate', baseUrl);
    } catch {
      finish({ unavailable: true });
      return;
    }

    const body = JSON.stringify({ model, prompt, stream });

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        // Headers arrived: Ollama (or at least *something*) is reachable
        // and responding, so the connect timeout no longer applies — the
        // rest of this callback only reads the body, unbounded (a slow
        // generation is not "unavailable").
        clearTimeout(connectTimer);

        /** @type {Buffer[]} */
        const chunks = [];
        let buffered = '';

        res.on('data', (chunk) => {
          chunks.push(chunk);
          if (!stream || !onChunk) return;
          buffered += chunk.toString('utf-8');
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsedLine = JSON.parse(trimmed);
              if (typeof parsedLine.response === 'string' && parsedLine.response) onChunk(parsedLine.response);
            } catch {
              // A malformed line mid-stream is skipped, not fatal — the
              // final full-body parse below is what actually determines
              // the resolved result.
            }
          }
        });

        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          finish({ unavailable: false, response: parse_generate_body(raw, stream) });
        });

        res.on('error', () => finish({ unavailable: true }));
      }
    );

    connectTimer = setTimeout(() => {
      req.destroy();
      finish({ unavailable: true });
    }, timeoutMs);

    req.on('error', () => finish({ unavailable: true }));

    if (signal) signal.addEventListener('abort', on_abort);

    req.write(body);
    req.end();
  });
}

/**
 * Extracts the concatenated `response` text from a raw `/api/generate`
 * body. Non-streaming: a single JSON object, `response` is already the
 * full text — an unparseable body resolves to `''` (this module's
 * "garbage in, empty response out — never `unavailable`" contract; see
 * file header). Streaming: newline-delimited JSON objects, one per token
 * — concatenates every line's `response` field, skipping any individual
 * line that fails to parse rather than discarding the whole result over
 * one bad line.
 * @param {string} raw
 * @param {boolean} stream
 * @returns {string}
 */
export function parse_generate_body(raw, stream) {
  if (!stream) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed.response === 'string' ? parsed.response : '';
    } catch {
      return '';
    }
  }

  let out = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.response === 'string') out += parsed.response;
    } catch {
      // skip malformed line — see doc comment above.
    }
  }
  return out;
}
