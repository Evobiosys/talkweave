// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — request router. Pure-ish dispatch: API routes are handled here,
// unmatched non-/api paths delegate to static_files.mjs (production mode).
// Disk access lives only in static_files.mjs and sessions.mjs, so this
// module stays unit-testable with fake req/res objects (a tmp dir stands in
// for real disk access in the session-route tests).

import { serve_static } from './static_files.mjs';
import {
  create_session,
  is_valid_session_id,
  list_sessions,
  read_audio,
  read_session,
  write_audio,
  write_session
} from './sessions.mjs';
import { parse_session_md } from './session_md_parse.mjs';
import { MAX_AUDIO_EMBED_BYTES, render_export_html } from './export.mjs';
import { ollama_generate } from './ollama.mjs';
import { check_whisper_availability, create_mic_stream_registry } from './whisper_stream.mjs';
import {
  build_claim_prompt,
  locate_claim,
  most_recent_final_segment_before,
  sentence_fallback,
  strip_wrapping_quotes
} from './claim.mjs';
import { build_summary_prompt, truncate_to_bullets } from './summary.mjs';
import {
  build_contradiction_prompt,
  build_deep_prompt,
  build_quick_prompt,
  parse_contradiction_response,
  read_deep_stats,
  record_deep_duration
} from './factcheck.mjs';
import { build_freeform_prompt, build_same_topic_prompt } from './ask.mjs';

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function send_json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * @typedef {{
 *   staticRoot?: string;
 *   sessionsRoot?: string;
 *   landingRoot?: string;
 *   repoRoot?: string;
 *   whisperAvailabilityCheck?: () => ({ available: boolean; bin: string; model: string; modelPresent: boolean; engine?: 'qwen' | 'whisper' | 'none' }) | Promise<{ available: boolean; bin: string; model: string; modelPresent: boolean; engine?: 'qwen' | 'whisper' | 'none' }>;
 *   micRegistry?: ReturnType<typeof import('./whisper_stream.mjs').create_mic_stream_registry>;
 *   ollamaGenerate?: (args: { model: string; prompt: string; signal?: AbortSignal; stream?: boolean }) => Promise<{ unavailable: boolean; response?: string }>;
 * }} RouteOptions
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, options: RouteOptions) => void | Promise<void>} RouteHandler
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, options: RouteOptions, id: string) => void | Promise<void>} SessionRouteHandler
 */

/**
 * GET /api/health
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 */
function handle_health(_req, res) {
  send_json(res, 200, { ok: true });
}

/**
 * Buffers the full request body. Works against a real
 * `http.IncomingMessage` (itself an async-iterable Readable stream) and
 * against any async-iterable fake used in tests.
 * @param {AsyncIterable<Buffer | Uint8Array | string>} req
 * @returns {Promise<Buffer>}
 */
async function read_body(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * POST /api/session — creates a new session, optionally seeded with a
 * `{ title, names }` JSON body. A missing or malformed body falls back to
 * defaults rather than 400ing: the normal "begin conversation" flow sends
 * no body at all.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_create_session(req, res, _url, options) {
  if (!options.sessionsRoot) {
    send_json(res, 500, { ok: false, error: 'server_misconfigured' });
    return;
  }
  /** @type {{ title?: string; names?: { L: string; R: string } }} */
  const opts = {};
  const bodyBuf = await read_body(req);
  if (bodyBuf.length > 0) {
    try {
      const parsed = JSON.parse(bodyBuf.toString('utf-8'));
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.title === 'string') opts.title = parsed.title;
        if (parsed.names && typeof parsed.names.L === 'string' && typeof parsed.names.R === 'string') {
          opts.names = { L: parsed.names.L, R: parsed.names.R };
        }
      }
    } catch {
      // malformed JSON: ignore, fall back to defaults.
    }
  }
  const created = await create_session(options.sessionsRoot, opts);
  send_json(res, 201, { ok: true, ...created });
}

/**
 * GET /api/sessions
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_list_sessions(_req, res, _url, options) {
  if (!options.sessionsRoot) {
    send_json(res, 500, { ok: false, error: 'server_misconfigured' });
    return;
  }
  const sessions = await list_sessions(options.sessionsRoot);
  send_json(res, 200, { ok: true, sessions });
}

/**
 * GET /api/session/:id — returns the raw session.md text.
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handle_get_session(_req, res, _url, options, id) {
  if (!options.sessionsRoot) {
    send_json(res, 500, { ok: false, error: 'server_misconfigured' });
    return;
  }
  if (!is_valid_session_id(id)) {
    send_json(res, 400, { ok: false, error: 'invalid_id' });
    return;
  }
  const md = await read_session(options.sessionsRoot, id);
  if (md === null) {
    send_json(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  const body = Buffer.from(md, 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

/**
 * PUT /api/session/:id — overwrites session.md with the raw request body
 * (the client's serialized markdown). Server treats it as opaque text; no
 * parsing happens here.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handle_put_session(req, res, _url, options, id) {
  if (!options.sessionsRoot) {
    send_json(res, 500, { ok: false, error: 'server_misconfigured' });
    return;
  }
  if (!is_valid_session_id(id)) {
    send_json(res, 400, { ok: false, error: 'invalid_id' });
    return;
  }
  const bodyBuf = await read_body(req);
  const ok = await write_session(options.sessionsRoot, id, bodyBuf.toString('utf-8'));
  send_json(res, ok ? 200 : 400, { ok });
}

/**
 * POST /api/session/:id/audio — buffers the raw request body (Content-Type
 * audio/webm) to audio.webm.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handle_post_audio(req, res, _url, options, id) {
  if (!options.sessionsRoot) {
    send_json(res, 500, { ok: false, error: 'server_misconfigured' });
    return;
  }
  if (!is_valid_session_id(id)) {
    send_json(res, 400, { ok: false, error: 'invalid_id' });
    return;
  }
  const bodyBuf = await read_body(req);
  const ok = await write_audio(options.sessionsRoot, id, bodyBuf);
  send_json(res, ok ? 200 : 400, { ok });
}

/**
 * Parses a single-`Range` `Range` header (RFC 7233 §2.1) against a
 * resource of `totalSize` bytes. Amended, controller-ruled requirement
 * (fix round 2, internal build notes, commit
 * `522c62c`): `<audio>` seeking in a browser leans on Range support to
 * both resolve a real (non-`Infinity`) `duration` for a recorded webm
 * and to actually land a seek at the requested byte offset; without it,
 * a click far across the review-mode timeline could silently re-buffer
 * from the start instead of landing near the requested time.
 *
 * Supports the three forms real `<audio>` elements send: explicit
 * (`bytes=0-499`), open-ended (`bytes=500-`), and suffix (`bytes=-500`,
 * "last 500 bytes"). A multi-range request (`bytes=0-10,20-30` — nothing
 * this app's own `<audio>` element ever sends) is treated as
 * unsatisfiable rather than assembled into a multipart response, since
 * there is no real client here that needs it (YAGNI).
 *
 * @param {string | undefined} rangeHeader
 * @param {number} totalSize
 * @returns {{ start: number; end: number } | 'unsatisfiable' | null}
 *   `null` — no `Range` header at all; caller serves the full body as a
 *   plain `200`. `'unsatisfiable'` — malformed, multi-range, or
 *   out-of-bounds; caller responds `416`. Otherwise an inclusive
 *   `[start, end]` byte range, both bounds within `[0, totalSize - 1]`.
 */
export function parse_range(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return 'unsatisfiable'; // malformed, wrong unit, or multi-range (contains a comma)
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return 'unsatisfiable';
  if (totalSize <= 0) return 'unsatisfiable';

  if (startStr === '') {
    // Suffix range: "bytes=-500" -> the last 500 bytes.
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    return { start: Math.max(0, totalSize - suffixLength), end: totalSize - 1 };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) return 'unsatisfiable';

  const end = endStr === '' ? totalSize - 1 : Number(endStr);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';

  return { start, end: Math.min(end, totalSize - 1) };
}

/**
 * GET /api/session/:id/audio — streams audio.webm back, with HTTP Range
 * support (see `parse_range`'s doc comment for why this is now required).
 * No `Range` header: full file, `200`, `Accept-Ranges: bytes` advertised
 * so the client knows it *can* range-request next time. A satisfiable
 * `Range`: the requested slice, `206 Partial Content` + `Content-Range`.
 * An unsatisfiable one: `416 Range Not Satisfiable` + `Content-Range:
 * bytes * /<size>` (no body), per RFC 7233 §4.4.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handle_get_audio(req, res, _url, options, id) {
  if (!options.sessionsRoot) {
    send_json(res, 500, { ok: false, error: 'server_misconfigured' });
    return;
  }
  if (!is_valid_session_id(id)) {
    send_json(res, 400, { ok: false, error: 'invalid_id' });
    return;
  }
  const data = await read_audio(options.sessionsRoot, id);
  if (data === null) {
    send_json(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  const range = parse_range(req.headers?.['range'], data.length);

  if (range === null) {
    res.writeHead(200, {
      'Content-Type': 'audio/webm',
      'Content-Length': data.length,
      'Accept-Ranges': 'bytes'
    });
    res.end(data);
    return;
  }

  if (range === 'unsatisfiable') {
    res.writeHead(416, {
      'Content-Type': 'audio/webm',
      'Content-Range': `bytes */${data.length}`,
      'Accept-Ranges': 'bytes'
    });
    res.end();
    return;
  }

  const { start, end } = range;
  const chunk = data.subarray(start, end + 1);
  res.writeHead(206, {
    'Content-Type': 'audio/webm',
    'Content-Length': chunk.length,
    'Content-Range': `bytes ${start}-${end}/${data.length}`,
    'Accept-Ranges': 'bytes'
  });
  res.end(chunk);
}

/**
 * GET /api/session/:id/export — task-11-brief.md: a single self-contained
 * black-themed HTML file rendering the session's transcript, flags, notes,
 * summaries, fact-checks, and (when small enough) its audio recording as a
 * base64 `data:` URI. `session.md` is parsed server-side via
 * `session_md_parse.mjs`'s hand-rolled port of shared/session_md.ts's
 * `parse_session` (see that module's header comment for why a direct
 * import isn't possible), then rendered by `export.mjs`.
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handle_get_export(_req, res, _url, options, id) {
  if (!options.sessionsRoot) {
    send_json(res, 500, { ok: false, error: 'server_misconfigured' });
    return;
  }
  if (!is_valid_session_id(id)) {
    send_json(res, 400, { ok: false, error: 'invalid_id' });
    return;
  }
  const md = await read_session(options.sessionsRoot, id);
  if (md === null) {
    send_json(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  const session = parse_session_md(md);

  /** @type {import('./export.mjs').ExportAudio} */
  let audio = null;
  if (session.audioFile !== null) {
    const data = await read_audio(options.sessionsRoot, id);
    if (data !== null) {
      audio = data.length >= MAX_AUDIO_EMBED_BYTES ? { tooLarge: true, bytes: data.length } : { tooLarge: false, base64: data.toString('base64') };
    }
  }

  const html = render_export_html(session, audio);
  const body = Buffer.from(html, 'utf-8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="talkweave-${id}.html"`
  });
  res.end(body);
}

/**
 * GET /landing and /landing/ — task-11-brief.md: serves the self-contained
 * static landing page (`landing/index.html`) independently of the built
 * SPA (`app/dist`, `options.staticRoot`) — the landing page has no build
 * step and lives in its own top-level directory. Reuses `serve_static`'s
 * directory -> index.html resolution rather than duplicating it: passing
 * pathname `/` against `options.landingRoot` resolves to exactly
 * `<landingRoot>/index.html`.
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_landing(_req, res, _url, options) {
  if (!options.landingRoot) {
    send_json(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  await serve_static(res, '/', options.landingRoot);
}

/**
 * GET /api/whisper/available — task-8-brief.md's original mic-engine
 * detection, evolved for v0.2 (DEVLOG/v02-live-transcription_of-talkweave_
 * handover.md): now reports `{available, bin, model, modelPresent}`
 * instead of a bare boolean, so the settings drawer can distinguish
 * "whisper-cli not installed" from "installed but no model file" instead
 * of collapsing both into one disabled option — see
 * app/src/lib/whisper_status.ts and settings_drawer.svelte for the
 * three-state label this drives, and app.svelte's `session_mode_plan`
 * call for the OTHER consumer (gating whether a live session actually
 * starts the real mic engine). `options.whisperAvailabilityCheck` is the
 * injection seam for tests — real requests never set it, so
 * `check_whisper_availability` (whisper_stream.mjs: the real `which
 * whisper-cli` shell-out + model-file existence check) runs.
 *
 * v0.3 (DEVLOG/qwen-asr-engine_of-talkweave_handover.md): now `await`s
 * `check()` — server.mjs's real injected check re-probes the qwen proxy
 * over the network (asr_engine.mjs's `checkAvailability`), which is
 * necessarily async, unlike the original synchronous `which`-shell-out
 * check. A synchronous test stub still works unchanged: `await` on a
 * plain object resolves to that same object.
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_whisper_available(_req, res, _url, options) {
  const check = options.whisperAvailabilityCheck ?? (() => check_whisper_availability({ repoRoot: options.repoRoot }));
  const status = await check();
  send_json(res, 200, { ok: true, ...status });
}

/**
 * Real registry used in production when none is injected — constructed
 * lazily (module-scoped singleton) rather than per-request, so a real
 * server actually shares one set of live mic streams across requests.
 * Tests always inject their own via `options.micRegistry` (fresh per
 * test file, so `sweepMs: 0` keeps no timer alive past that file's own
 * teardown) — this lazy singleton is never touched by the test suite.
 * @type {ReturnType<typeof create_mic_stream_registry> | null}
 */
let defaultMicRegistry = null;
/** @returns {ReturnType<typeof create_mic_stream_registry>} */
function get_default_mic_registry() {
  if (!defaultMicRegistry) defaultMicRegistry = create_mic_stream_registry();
  return defaultMicRegistry;
}

/**
 * POST /api/mic/start — v0.2 live transcription. Creates one live
 * mic-transcription stream (server/lib/whisper_stream.mjs) and returns its
 * id; the client then POSTs raw 16kHz mono PCM16 chunks to
 * `/api/mic/audio/:id` and opens `GET /api/mic/stream/:id` (SSE) to
 * receive `partial`/`final` transcription events — see
 * app/src/lib/mic_engine.ts. Refuses to start (503) when whisper isn't
 * actually usable (binary missing OR model missing) rather than creating a
 * stream that could only ever emit empty text — the client treats a
 * non-2xx `/api/mic/start` response as "whisper unavailable," the same
 * graceful-degradation path a mid-session failure takes (handover step 6:
 * "a live session with mic engine selected but whisper unavailable should
 * behave like v0.1's live session").
 * v0.3: `await`s `checkAvailable()` — see `handle_whisper_available`'s
 * doc comment above for why (same seam, same async-capable contract).
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_mic_start(_req, res, _url, options) {
  const checkAvailable = options.whisperAvailabilityCheck ?? (() => check_whisper_availability({ repoRoot: options.repoRoot }));
  const status = await checkAvailable();
  if (!status.available || !status.modelPresent) {
    send_json(res, 503, { ok: false, error: 'whisper_unavailable' });
    return;
  }
  const registry = options.micRegistry ?? get_default_mic_registry();
  const streamId = registry.create();
  send_json(res, 200, { ok: true, streamId });
}

/**
 * POST /api/mic/audio/:id — appends one raw PCM16LE mono 16kHz chunk (the
 * request body, `Content-Type: application/octet-stream`, no JSON
 * envelope — same "raw bytes as the body" convention as `POST
 * /api/session/:id/audio`'s webm upload) to stream `:id`'s current
 * transcription window. 404 for an unknown/already-stopped stream id
 * (client-side `mic_engine.ts` treats this as fatal for the current
 * session — see that module's header comment).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handle_mic_audio(req, res, _url, options, id) {
  const registry = options.micRegistry ?? get_default_mic_registry();
  const bodyBuf = await read_body(req);
  const ok = registry.append_audio(id, bodyBuf);
  send_json(res, ok ? 200 : 404, { ok });
}

/**
 * POST /api/mic/flush/:id — forces stream `:id`'s current transcription
 * window to close now: one last re-decode of whatever's buffered, emitted
 * as a `final` SSE event, then the window resets. `mic_engine.ts` calls
 * this the instant a manual ArrowLeft/ArrowRight speaker switch happens
 * (handover step 4/1's "turn boundary = speaker change" design) — see
 * that module's header comment for the full sequencing.
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handle_mic_flush(_req, res, _url, options, id) {
  const registry = options.micRegistry ?? get_default_mic_registry();
  const ok = await registry.flush(id);
  send_json(res, ok ? 200 : 404, { ok });
}

/**
 * POST /api/mic/stop/:id — tears down stream `:id` (timer cleared,
 * listeners dropped, removed from the registry). Idempotent-ish: stopping
 * an already-stopped/unknown id answers `{ok:false}` with 404 rather than
 * throwing — `mic_engine.ts`'s `stop()` calls this best-effort and doesn't
 * treat a 404 here as an error (the stream may have already been swept as
 * stale, or already stopped by a previous call).
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 */
function handle_mic_stop(_req, res, _url, options, id) {
  const registry = options.micRegistry ?? get_default_mic_registry();
  const ok = registry.stop(id);
  send_json(res, ok ? 200 : 404, { ok });
}

/**
 * GET /api/mic/stream/:id — SSE stream of stream `:id`'s `partial`/`final`
 * transcription events (whisper_stream.mjs's `MicStreamEvent`, written via
 * the same `write_sse_event` helper `POST /api/factcheck` uses). Plain
 * `GET`+`EventSource`-shaped on the wire, but `mic_engine.ts` still
 * consumes it via `fetch`+`AbortController` (matching
 * `factcheck_client.ts`'s precedent) rather than the real `EventSource`
 * API — `EventSource` auto-reconnects on a dropped connection, which would
 * silently re-attach to a stream the client already called
 * `/api/mic/stop/:id` on. 404 (plain JSON, no SSE headers ever sent) for
 * an unknown stream id.
 *
 * v0.2 fix round 1 (Important 2, review): `res`'s `'close'` event (client
 * aborts, or the underlying TCP connection drops for any other reason —
 * same abort-detection convention as `handle_factcheck`) now stops the
 * WHOLE underlying stream (`registry.stop(id)`), not just this route's own
 * SSE subscription. Before this fix, a dropped connection only removed
 * the listener — the registry's tick loop kept spawning `whisper-cli`
 * every `tickMs` regardless, with nobody left to ever read the events it
 * produced, until the registry's own stale-sweep (`DEFAULT_STALE_MS`,
 * whisper_stream.mjs — up to 120s later) finally noticed. No grace/
 * reconnect window before stopping: `mic_engine.ts`'s SSE consumer
 * deliberately never reconnects (see that module's header comment on why
 * it avoids `EventSource`'s auto-reconnect), so once THIS specific
 * connection closes, nothing on the client side is ever coming back to
 * read from this stream id again — waiting would only delay killing the
 * tick loop for no benefit. If a future client version adds real
 * reconnect support, this is the one place that would need a grace
 * window added.
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @param {string} id
 */
function handle_mic_stream(_req, res, _url, options, id) {
  const registry = options.micRegistry ?? get_default_mic_registry();
  if (!registry.has(id)) {
    send_json(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const unsubscribe = registry.subscribe(id, (event) => {
    write_sse_event(res, event.final ? 'final' : 'partial', event);
  });

  res.on('close', () => {
    unsubscribe?.();
    registry.stop(id);
  });
}

const DEFAULT_CLAIM_MODEL = 'qwen3:4b';
const DEFAULT_SUMMARY_MODEL = 'qwen3:4b';
const DEFAULT_FACTCHECK_QUICK_MODEL = 'qwen3:4b';
const DEFAULT_FACTCHECK_DEEP_MODEL = 'qwen3.6-27b-iq4:latest';
// "Ask the conversation" (recall/contradiction/freeform) is always a
// SINGLE judge/answer call, never the quick+deep two-stage factcheck
// does — so it gets the fast model class, same as factcheck's own quick
// stage, not the slow deep one.
const DEFAULT_ASK_MODEL = 'qwen3:4b';

/**
 * Real seam used in production: wraps ollama.mjs's client with no
 * `baseUrl` override (defaults to the real Ollama daemon at
 * 127.0.0.1:11434). `options.ollamaGenerate` is the injection point for
 * tests — same pattern as `options.whisperCheck` above; tests inject a
 * fake matching this shape rather than standing up a real stub http
 * server here (that's reserved for ollama.mjs's own unit tests).
 * @param {{ model: string; prompt: string; signal?: AbortSignal; stream?: boolean }} args
 * @returns {Promise<{ unavailable: boolean; response?: string }>}
 */
function default_ollama_generate(args) {
  return ollama_generate({ model: args.model, prompt: args.prompt, signal: args.signal, stream: args.stream });
}

/**
 * POST /api/llm/claim — task-9-brief.md. Always answers 200 with SOME
 * claim result (`via: 'llm'` or `'fallback'`) once the request body is
 * well-formed; Ollama being unreachable never surfaces as an HTTP error to
 * the client, only as `ollamaAvailable: false` (app.svelte's "local AI
 * offline" chip reads exactly this field — NOT the same thing as `via:
 * 'fallback'`, which also legitimately happens while Ollama IS up,
 * whenever its returned text doesn't validate as a verbatim substring of
 * the transcript).
 *
 * `ollamaAvailable` is `null`, not `true`, when there was no eligible
 * other-speaker segment at all (review fix round 1, Important 4): in that
 * case `generate` is never even called, so answering `true` would be an
 * outright lie — a client reading it as "Ollama just answered
 * successfully" would wrongly clear an already-showing "local AI offline"
 * chip based on a call that never happened. `null` means "not contacted
 * this time, draw no conclusion about availability either way" — the
 * client-side `ollama_offline_next_state` (ai_pipeline.ts) leaves whatever
 * chip state was already showing untouched on `null`, only ever setting
 * or clearing it from a call that genuinely reached (or failed to reach)
 * Ollama.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_llm_claim(req, res, _url, options) {
  const bodyBuf = await read_body(req);
  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf-8'));
  } catch {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.context) || typeof parsed.flagT !== 'number') {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }

  const context = parsed.context;
  const flagT = parsed.flagT;
  const principles = typeof parsed.principles === 'string' ? parsed.principles : undefined;
  const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_CLAIM_MODEL;

  const generate = options.ollamaGenerate ?? default_ollama_generate;
  const target = most_recent_final_segment_before(context, flagT);

  /** @type {boolean | null} */
  let ollamaAvailable = null;
  let llmClaim = '';
  if (target) {
    const prompt = build_claim_prompt(context, flagT, principles);
    const result = await generate({ model, prompt });
    if (result.unavailable) {
      ollamaAvailable = false;
    } else {
      ollamaAvailable = true;
      llmClaim = strip_wrapping_quotes((result.response ?? '').trim());
    }
  }

  if (llmClaim) {
    const located = locate_claim(context, llmClaim, flagT);
    if (located) {
      send_json(res, 200, {
        ok: true,
        claim: llmClaim,
        segmentId: located.segmentId,
        charStart: located.charStart,
        charEnd: located.charEnd,
        via: 'llm',
        ollamaAvailable
      });
      return;
    }
  }

  const fallback = sentence_fallback(context, flagT);
  send_json(res, 200, {
    ok: true,
    claim: fallback ? fallback.text : null,
    segmentId: fallback ? fallback.segmentId : null,
    charStart: fallback ? fallback.charStart : null,
    charEnd: fallback ? fallback.charEnd : null,
    via: 'fallback',
    ollamaAvailable
  });
}

/**
 * POST /api/llm/summary — task-9-brief.md. Ollama unreachable degrades to
 * `{ ok: true, unavailable: true, text: null }` (a silent no-op — the
 * client doesn't add a summary and flips its "local AI offline" chip),
 * never a 4xx/5xx: a well-formed request that simply couldn't be answered
 * right now is not a client error.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_llm_summary(req, res, _url, options) {
  const bodyBuf = await read_body(req);
  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf-8'));
  } catch {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.segments) ||
    typeof parsed.tFrom !== 'number' ||
    typeof parsed.tTo !== 'number'
  ) {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }

  const segments = parsed.segments;
  const tFrom = parsed.tFrom;
  const tTo = parsed.tTo;
  const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_SUMMARY_MODEL;

  const generate = options.ollamaGenerate ?? default_ollama_generate;
  const prompt = build_summary_prompt(segments, tFrom, tTo);
  const result = await generate({ model, prompt });

  if (result.unavailable) {
    send_json(res, 200, { ok: true, unavailable: true, text: null });
    return;
  }

  const text = truncate_to_bullets((result.response ?? '').trim());
  send_json(res, 200, { ok: true, unavailable: false, text: text || null });
}

/**
 * Writes one Server-Sent Event to `res`. Per-field payload is always a
 * single JSON-encoded `data:` line — none of this route's events need
 * multi-line `data:` framing, so the simpler single-line form is all that's
 * implemented (YAGNI).
 * @param {import('node:http').ServerResponse} res
 * @param {string} event
 * @param {unknown} data
 */
function write_sse_event(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST /api/factcheck — task-10-brief.md. Streams `quick` -> `deep_eta` ->
 * `deep` -> `done` as Server-Sent Events over the response of the SAME POST
 * request (not a separate GET the browser's native `EventSource` could
 * attach to — that API can't send a body — so the real client is a `fetch`
 * with a streamed response body; see `app/src/lib/factcheck_client.ts`).
 *
 * Every step degrades the same way the rest of this file's LLM routes do:
 * an unreachable Ollama never throws or 5xxs mid-stream, it just produces
 * an empty-text event and the pipeline continues (the contradiction check
 * is skipped outright when either the quick or deep call itself was
 * unavailable — there is nothing meaningful to compare).
 *
 * Abort: `res`'s `'close'` event fires when the underlying TCP connection
 * drops — checked against `res.writableEnded` so a NORMAL end (this
 * handler's own final `res.end()`, after `done` was already written)
 * isn't mistaken for a client-initiated abort. `req`'s own `'close'` is
 * NOT used for this: it fires as soon as the (already fully-buffered)
 * request body finishes being read, long before the client actually
 * disconnects, which would trip the abort path immediately on every
 * request. One `AbortController` is reused across all three Ollama calls
 * (quick, deep, contradiction) in this single request — whichever one is
 * in flight when the client disconnects is the one that gets torn down.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_factcheck(req, res, _url, options) {
  const bodyBuf = await read_body(req);
  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf-8'));
  } catch {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.question !== 'string' ||
    !parsed.question.trim() ||
    !Array.isArray(parsed.context)
  ) {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }

  const question = parsed.question.trim();
  const context = parsed.context;
  const modelsRaw = parsed.models && typeof parsed.models === 'object' ? parsed.models : {};
  const quickModel = typeof modelsRaw.quick === 'string' && modelsRaw.quick ? modelsRaw.quick : DEFAULT_FACTCHECK_QUICK_MODEL;
  const deepModel = typeof modelsRaw.deep === 'string' && modelsRaw.deep ? modelsRaw.deep : DEFAULT_FACTCHECK_DEEP_MODEL;
  const sessionsRoot = options.sessionsRoot;

  const generate = options.ollamaGenerate ?? default_ollama_generate;
  const controller = new AbortController();
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      controller.abort();
    }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  try {
    const quickStart = Date.now();
    const quickResult = await generate({
      model: quickModel,
      prompt: build_quick_prompt(question, context),
      signal: controller.signal,
      stream: true
    });
    if (aborted) return;
    const quickMs = Date.now() - quickStart;
    const quickText = quickResult.unavailable ? '' : (quickResult.response ?? '').trim();
    write_sse_event(res, 'quick', { text: quickText, model: quickModel, ms: quickMs });

    const stats = sessionsRoot ? await read_deep_stats(sessionsRoot) : { avgMs: 45000, count: 0 };
    if (aborted) return;
    const etaMs = Math.round(stats.avgMs);
    write_sse_event(res, 'deep_eta', { etaMs });

    const deepStart = Date.now();
    const deepResult = await generate({
      model: deepModel,
      prompt: build_deep_prompt(question, context),
      signal: controller.signal,
      // `stream: true` (not the router's other LLM routes' default
      // `false`): the deep model can legitimately take task-10-brief.md's
      // ~40s to answer, and Ollama's non-streaming `/api/generate` doesn't
      // write ANY response bytes — headers included — until the full
      // generation is done. `ollama.mjs`'s connect timeout only bounds
      // time-to-first-byte (see that file's header comment), so against a
      // non-streaming call it would, in effect, bound the ENTIRE
      // generation to `CONNECT_TIMEOUT_MS` (1.5s) — a real deep answer
      // would ALWAYS resolve `unavailable: true` before it ever got a
      // chance to finish (confirmed against a deliberately slow stub
      // during this task's headless smoke test). Streaming mode has
      // Ollama flush headers as soon as the first token exists, which
      // happens almost immediately even for a slow multi-second
      // generation, so the timeout still means what it says: "Ollama
      // never responded at all," not "Ollama is still thinking." No
      // `onChunk` is passed — this route only needs the final
      // concatenated text (`ollama_generate` already accumulates the full
      // NDJSON stream into one `response` string regardless of whether a
      // per-token callback is given), not live per-token delivery.
      stream: true
    });
    if (aborted) return;
    const deepMs = Date.now() - deepStart;
    const deepText = deepResult.unavailable ? '' : (deepResult.response ?? '').trim();

    if (!deepResult.unavailable && sessionsRoot) {
      await record_deep_duration(sessionsRoot, deepMs);
      if (aborted) return;
    }

    let contradicts = false;
    let nuance = '';
    if (!quickResult.unavailable && !deepResult.unavailable) {
      // Fix round 1 (task review, Important finding): this step is
      // deliberately isolated in its OWN try/catch, separate from the
      // outer one — task-10-brief.md requires the contradiction check's
      // failure to never kill the whole stream, and relying solely on
      // `ollama_generate`'s "never throws" convention made that guarantee
      // incidental rather than structural. A genuine throw here (as
      // opposed to `generate` resolving `{unavailable: true}`, already
      // handled below) now falls back to the same "nothing to compare"
      // defaults, and — critically — execution still reaches the `deep`
      // event write below unconditionally (the deep answer was already
      // computed before this block ever ran).
      try {
        const contradictionResult = await generate({
          model: quickModel,
          prompt: build_contradiction_prompt(question, quickText, deepText),
          signal: controller.signal,
          stream: true
        });
        if (aborted) return;
        if (!contradictionResult.unavailable) {
          const parsedContradiction = parse_contradiction_response(contradictionResult.response ?? '');
          contradicts = parsedContradiction.contradicts;
          nuance = parsedContradiction.nuance;
        }
      } catch {
        contradicts = false;
        nuance = '';
      }
    }

    write_sse_event(res, 'deep', { text: deepText, model: deepModel, ms: deepMs, contradicts, nuance });
    write_sse_event(res, 'done', {});
  } catch {
    // A genuinely unexpected error mid-stream must never escape to
    // server.mjs's top-level catch (it would try `res.writeHead(500)` —
    // headers are already sent by this point — then append a JSON error
    // blob into the middle of an SSE stream). Swallow it here; the client
    // just sees the stream end with no further events, same as an abort.
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * POST /api/ask — "ask the conversation about itself" handover, part 2's
 * model-judging step. NOT SSE, unlike /api/factcheck: this route is
 * always exactly one Ollama call (a same-topic judgement, a contradiction
 * judgement, or a free-form answer), never factcheck's two-stage quick-
 * then-deep reveal, so there is nothing progressive to stream — a plain
 * JSON response once the single call resolves is the right amount of
 * mechanism, not a second SSE parser for a shape that never has more than
 * one event worth sending. "Real progress" for this route is the
 * client's own count-up elapsed-time UI (ask_card.svelte) rather than a
 * server-pushed ETA — there is no historical-duration store for this
 * call the way `.deep_stats.json` backs factcheck's deep ETA, and this
 * call always uses the fast model class (DEFAULT_ASK_MODEL), not the
 * pathologically slow deep one that ETA exists for.
 *
 * The RETRIEVAL that produced `candidates` already happened entirely
 * client-side (app/src/lib/retrieval.ts) before this route is ever
 * called — this handler never re-derives or second-guesses that
 * shortlist, it only judges/answers over it. That is what makes the two
 * presets work with Ollama unreachable: the client already has and shows
 * its retrieved evidence before this request is even sent.
 *
 * Cancel: same `res.on('close')` -> `controller.abort()` pattern as
 * `handle_factcheck` — a client-initiated abort (the card's dismiss
 * button aborting the fetch) tears down whichever Ollama call is in
 * flight, not just the local UI state.
 *
 * Degrades the same way every other LLM route in this file does: Ollama
 * unreachable is answered as `{ ok: true, unavailable: true, text: null
 * }`, never a 4xx/5xx — a well-formed request that simply couldn't be
 * judged/answered right now is not a client error.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} _url
 * @param {RouteOptions} options
 * @returns {Promise<void>}
 */
async function handle_ask(req, res, _url, options) {
  const bodyBuf = await read_body(req);
  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf-8'));
  } catch {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed.mode !== 'recall' && parsed.mode !== 'contradiction' && parsed.mode !== 'freeform') ||
    typeof parsed.question !== 'string' ||
    !parsed.question.trim() ||
    !Array.isArray(parsed.candidates)
  ) {
    send_json(res, 400, { ok: false, error: 'invalid_body' });
    return;
  }

  const mode = parsed.mode;
  const question = parsed.question.trim();
  /** @type {import('./ask.mjs').AskCandidate[]} */
  const candidates = parsed.candidates.filter(
    /** @param {unknown} c */ (c) => c && typeof c === 'object' && typeof (/** @type {any} */ (c).text) === 'string'
  );
  const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_ASK_MODEL;

  const generate = options.ollamaGenerate ?? default_ollama_generate;
  const controller = new AbortController();
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      controller.abort();
    }
  });

  if (mode === 'freeform') {
    const prompt = build_freeform_prompt(question, candidates);
    const result = await generate({ model, prompt, signal: controller.signal, stream: true });
    if (aborted) return;
    if (result.unavailable) {
      send_json(res, 200, { ok: true, unavailable: true, text: null });
      return;
    }
    send_json(res, 200, { ok: true, unavailable: false, text: (result.response ?? '').trim() });
    return;
  }

  if (mode === 'recall') {
    // "Did we talk about this before?" judges the highlighted passage
    // against the SINGLE top-scored retrieval match only — retrieval's
    // ranking already answers "which one candidate is most likely the
    // same topic," and that is exactly the question this preset asks, so
    // there is nothing a second candidate would add.
    const top = candidates[0];
    if (!top) {
      // Retrieval found nothing to judge against — never contacted
      // Ollama, so `unavailable: null` (see handle_llm_claim's own doc
      // comment for this exact "not contacted, draw no conclusion"
      // convention).
      send_json(res, 200, { ok: true, unavailable: null, text: null });
      return;
    }
    const prompt = build_same_topic_prompt(question, top.text);
    const result = await generate({ model, prompt, signal: controller.signal, stream: true });
    if (aborted) return;
    if (result.unavailable) {
      send_json(res, 200, { ok: true, unavailable: true, text: null });
      return;
    }
    // Reused verbatim from factcheck.mjs, not reimplemented — its
    // "yes/no + one sentence" parsing already matches exactly what this
    // prompt asks for (see ask.mjs's header comment).
    const { contradicts, nuance } = parse_contradiction_response(result.response ?? '');
    send_json(res, 200, { ok: true, unavailable: false, text: nuance, sameTopic: contradicts });
    return;
  }

  // mode === 'contradiction'. Judges up to the top TWO retrieval matches,
  // SEQUENTIALLY, stopping at the first genuine contradiction found —
  // deliberately NOT the single-top-candidate rule "recall" uses above.
  // Retrieval's job (per this handover) is "find passages ABOUT THE SAME
  // THING," and the passage most topically similar to a highlight is very
  // often a RESTATEMENT in agreement, not a contradiction — this app's
  // own E2E fixture is exactly that case (a budget figure repeated in
  // agreement lands at rank 1). Judging only rank 1 would let a genuine
  // contradiction sitting at rank 2 go completely unseen. Bounded to 2,
  // not the whole shortlist, for the same reason a single judge call
  // already is: at this model's measured 55+ real seconds per call,
  // asking about more isn't survivable.
  const toJudge = candidates.slice(0, 2);
  if (toJudge.length === 0) {
    send_json(res, 200, { ok: true, unavailable: null, text: null });
    return;
  }

  // Never actually left at this default — `toJudge.length >= 1` is
  // guaranteed above, so the loop below always runs at least once and
  // reassigns `last` — but typed with a real fallback value (rather than
  // `null` + a non-null assertion at the call site) so this stays sound
  // without asserting anything the compiler can't itself verify.
  let last = { contradicts: false, nuance: '' };
  for (const candidate of toJudge) {
    const prompt = build_contradiction_prompt(
      'Do these two passages, both from the same conversation, contradict or materially nuance each other?',
      question,
      candidate.text
    );
    const result = await generate({ model, prompt, signal: controller.signal, stream: true });
    if (aborted) return;
    if (result.unavailable) {
      send_json(res, 200, { ok: true, unavailable: true, text: null });
      return;
    }
    last = parse_contradiction_response(result.response ?? '');
    if (last.contradicts) break; // found one — no need to check the second
  }

  send_json(res, 200, { ok: true, unavailable: false, text: last.nuance, contradicts: last.contradicts });
}

// Method + exact pathname -> handler.
/** @type {Record<string, RouteHandler>} */
const ROUTES = {
  'GET /api/health': handle_health,
  'POST /api/session': handle_create_session,
  'GET /api/sessions': handle_list_sessions,
  'GET /api/whisper/available': handle_whisper_available,
  'POST /api/mic/start': handle_mic_start,
  'POST /api/llm/claim': handle_llm_claim,
  'POST /api/llm/summary': handle_llm_summary,
  'POST /api/factcheck': handle_factcheck,
  'POST /api/ask': handle_ask,
  'GET /landing': handle_landing,
  'GET /landing/': handle_landing
};

// Method + pathname pattern -> handler, for routes with an :id segment.
// Checked after ROUTES so an exact match (e.g. GET /api/sessions) always
// wins over a pattern that could coincidentally also match it.
/** @type {{ method: string; pattern: RegExp; handler: SessionRouteHandler }[]} */
const SESSION_ROUTES = [
  { method: 'GET', pattern: /^\/api\/session\/([^/]+)$/, handler: handle_get_session },
  { method: 'PUT', pattern: /^\/api\/session\/([^/]+)$/, handler: handle_put_session },
  { method: 'POST', pattern: /^\/api\/session\/([^/]+)\/audio$/, handler: handle_post_audio },
  { method: 'GET', pattern: /^\/api\/session\/([^/]+)\/audio$/, handler: handle_get_audio },
  { method: 'GET', pattern: /^\/api\/session\/([^/]+)\/export$/, handler: handle_get_export },
  // v0.2 live transcription (mic streams keyed by streamId, not sessionId
  // — a mic stream's lifetime is one live session's recording, never
  // persisted, so it deliberately does NOT reuse `is_valid_session_id`'s
  // validation; any registry-unknown id already 404s via `registry.has`/
  // the append/flush/stop return-false path).
  { method: 'POST', pattern: /^\/api\/mic\/audio\/([^/]+)$/, handler: handle_mic_audio },
  { method: 'POST', pattern: /^\/api\/mic\/flush\/([^/]+)$/, handler: handle_mic_flush },
  { method: 'POST', pattern: /^\/api\/mic\/stop\/([^/]+)$/, handler: handle_mic_stop },
  { method: 'GET', pattern: /^\/api\/mic\/stream\/([^/]+)$/, handler: handle_mic_stream }
];

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {RouteOptions} [options]
 */
export async function handle_request(req, res, options = {}) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const routeKey = `${req.method} ${url.pathname}`;
  const handler = ROUTES[routeKey];

  if (handler) {
    await handler(req, res, url, options);
    return;
  }

  for (const route of SESSION_ROUTES) {
    if (req.method !== route.method) continue;
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    /** @type {string} */
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      send_json(res, 400, { ok: false, error: 'invalid_id' });
      return;
    }
    await route.handler(req, res, url, options, id);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    send_json(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  if (options.staticRoot) {
    await serve_static(res, url.pathname, options.staticRoot);
    return;
  }

  send_json(res, 404, { ok: false, error: 'not_found' });
}
