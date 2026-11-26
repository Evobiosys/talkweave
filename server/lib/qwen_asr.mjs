// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — thin client for the local Qwen3-ASR proxy stack (see
// DEVLOG/qwen-asr-engine_of-talkweave_handover.md). Same "thin client,
// injectable baseUrl, explicit timeout, graceful `{unavailable}`
// degradation, no throwing into the tick loop" shape as ollama.mjs and
// whisper_stream.mjs — this module is the WhisperRunFn-compatible
// alternative to whisper_stream.mjs's `default_whisper_run`, selected at
// startup by asr_engine.mjs when it demonstrably works.
//
// Topology this module talks to (binding at the time this was written):
// `~/qwen3_asr_rs/proxy.py`, an OpenAI-compatible HTTP proxy on
// 127.0.0.1:8001 that chunks anything longer than 28s and also serves a
// `/v1/realtime` websocket this module does not use. Upstream of THAT,
// `asr-serve` on 127.0.0.1:8000 advertises exactly one model, `qwen3-asr`,
// and answers `GET /v1/models` with 200 — this module's availability
// probe deliberately targets the UPSTREAM, not the proxy: the proxy
// itself answers 404 on every GET, `/v1/audio/transcriptions` included,
// so a GET against it is not a health signal, only a POST (or the
// upstream's own health route) is.
//
// Uses global `fetch`/`FormData`/`Blob`/`AbortController` (Node 18+
// stdlib globals, no runtime dependency added) rather than `node:http`
// like ollama.mjs — multipart/form-data encoding by hand over raw
// `node:http` would duplicate what `FormData` already does correctly.

const DEFAULT_PROXY_URL = 'http://127.0.0.1:8001';
const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:8000';
export const DEFAULT_ASR_MODEL = 'qwen3-asr';

// Real local-model throughput is 0.2-0.6x realtime (measured: 74s of audio
// in 45s, 133s in 27s, per the handover) — generous on purpose, this is a
// spawn against a resident local model, not a cloud API with predictable
// latency. Deliberately much larger than ollama.mjs's 1.5s connect timeout
// or whisper_stream.mjs's DEFAULT_WHISPER_TIMEOUT_MS (8s, sized for a
// short sliding window against a *different*, faster-assumed backend).
export const DEFAULT_ASR_TIMEOUT_MS = 35000;

// The availability probe is a plain `GET /v1/models`, not a transcription
// — it should fail fast so `/api/whisper/available` stays responsive
// rather than making the settings drawer/status chip wait out a
// transcription-scale timeout just to learn the proxy is down.
export const DEFAULT_ASR_PROBE_TIMEOUT_MS = 3000;

/**
 * `ASR_PROXY_URL` env override, else `http://127.0.0.1:8001`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolve_asr_proxy_url(env = process.env) {
  const raw = env.ASR_PROXY_URL;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_PROXY_URL;
}

/**
 * `ASR_UPSTREAM_URL` env override, else `http://127.0.0.1:8000`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolve_asr_upstream_url(env = process.env) {
  const raw = env.ASR_UPSTREAM_URL;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_UPSTREAM_URL;
}

/**
 * Strips `<asr_text>`-style wrapper tags from transcribed text. The proxy
 * already strips these on its own side, but this module does not rely on
 * that — a future proxy version or an unexpected upstream response could
 * reintroduce them, and a stray tag leaking into a transcript is a visible
 * user-facing bug worth guarding against defensively, cheaply.
 * @param {string} text
 * @returns {string}
 */
export function strip_asr_tags(text) {
  return text.replace(/<\/?asr_text>/gi, '').trim();
}

/**
 * Real `WhisperRunFn`-shaped transcribe call: POSTs `wavBytes` as
 * `multipart/form-data` to `${ctx.baseUrl}/v1/audio/transcriptions`
 * (fields `file`, filename `audio.wav`, type `audio/wav`; and `model`,
 * default `qwen3-asr`), and returns the OpenAI-shaped response's `text`
 * field, tag-stripped. Never throws: a network failure, non-2xx response,
 * malformed body, or `timeoutMs` watchdog firing all resolve `''` — same
 * "nothing new to say this round" contract as
 * `whisper_stream.mjs`'s `default_whisper_run`, which this function is a
 * drop-in alternative for (same signature, same return shape).
 * @type {(wavBytes: Buffer, ctx: { baseUrl?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch }) => Promise<string>}
 */
export async function asr_proxy_run(wavBytes, ctx = {}) {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const model = ctx.model ?? DEFAULT_ASR_MODEL;

  let target;
  try {
    target = new URL('/v1/audio/transcriptions', ctx.baseUrl ?? resolve_asr_proxy_url());
  } catch {
    return '';
  }

  const form = new FormData();
  // `new Uint8Array(wavBytes)` (not `wavBytes` directly): a `Buffer`'s
  // `.buffer` is typed as `ArrayBufferLike` (it could in principle be a
  // `SharedArrayBuffer`), which `Blob`'s constructor does not accept —
  // this copies into a fresh, plain `ArrayBuffer`-backed view instead of
  // relying on a cast to paper over the (here, never actually true)
  // SharedArrayBuffer case.
  form.append('file', new Blob([new Uint8Array(wavBytes)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);

  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), ctx.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS);
  try {
    const res = await fetchImpl(target, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) return '';
    /** @type {unknown} */
    let data;
    try {
      data = await res.json();
    } catch {
      return '';
    }
    const text = data && typeof data === 'object' && typeof (/** @type {any} */ (data).text) === 'string' ? /** @type {any} */ (data).text : '';
    return strip_asr_tags(text);
  } catch {
    // Network failure, DNS failure, or the watchdog's abort() firing —
    // all indistinguishable from here, and all mean "no text this round,"
    // matching default_whisper_run's own never-throws contract.
    return '';
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Availability probe: `GET ${upstreamUrl}/v1/models` (default
 * `http://127.0.0.1:8000`), since the proxy itself 404s on GET and is
 * therefore not a usable health signal (see module header). Returns the
 * same `{available, bin, model, modelPresent}` shape
 * `whisper_stream.mjs`'s `check_whisper_availability` returns, so
 * asr_engine.mjs's selection logic and router.mjs's existing
 * `/api/whisper/available` payload need no shape-specific branching:
 * `bin` reports the PROXY url (what transcription requests actually go
 * to), `model` the model name being asked for, and `modelPresent`
 * whether the upstream's own `/v1/models` list actually advertises it
 * (falling back to `true` on a 200 whose body doesn't parse as the
 * expected shape — an unreadable-but-reachable upstream is not the same
 * failure as a genuinely offline one).
 * @param {{ baseUrl?: string; upstreamUrl?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ available: boolean; bin: string; model: string; modelPresent: boolean }>}
 */
export async function check_asr_proxy_availability(options = {}) {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? resolve_asr_proxy_url(env);
  const upstreamUrl = options.upstreamUrl ?? resolve_asr_upstream_url(env);
  const model = options.model ?? DEFAULT_ASR_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  let target;
  try {
    target = new URL('/v1/models', upstreamUrl);
  } catch {
    return { available: false, bin: baseUrl, model, modelPresent: false };
  }

  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_ASR_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(target, { method: 'GET', signal: controller.signal });
    if (!res.ok) return { available: false, bin: baseUrl, model, modelPresent: false };

    let modelPresent = true;
    try {
      const data = await res.json();
      const list = data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).data) ? /** @type {any} */ (data).data : null;
      if (list) modelPresent = list.some((/** @type {any} */ entry) => entry && typeof entry === 'object' && entry.id === model);
    } catch {
      // 200 but unparseable body: the upstream IS reachable, which is the
      // thing this probe primarily exists to confirm — see doc comment.
    }
    return { available: true, bin: baseUrl, model, modelPresent };
  } catch {
    return { available: false, bin: baseUrl, model, modelPresent: false };
  } finally {
    clearTimeout(watchdog);
  }
}
