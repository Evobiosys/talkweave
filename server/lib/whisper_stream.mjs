// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — v0.2 live transcription (Candidate A, see
// DEVLOG/v02-live-transcription_of-talkweave_handover.md). Server-side
// adapter around a local whisper.cpp `whisper-cli` binary, following the
// same "thin client, timeout, graceful `{unavailable}` degradation" shape
// as server/lib/ollama.mjs.
//
// Environment fact this module is built against (binding at the time this
// was written): neither `whisper-cli` nor `cmake` is installed on this
// machine, and no network install is permitted mid-task. Every code path
// here is exercised in tests via an injected `whisperRun` stub (same
// injection-seam convention as ollama.mjs's `baseUrl` and router.mjs's
// `whisperCheck`) or, for one end-to-end test, a small STUB script that
// stands in for the real `whisper-cli` binary. `default_whisper_run` (the
// REAL spawn-a-binary path) is written from whisper.cpp's documented CLI
// shape but has never been run against the real binary — flagged here and
// in the README as the one thing a post-install session must verify.
//
// Mechanism (Candidate A's "Con" acknowledged and designed around, not
// hidden): rather than a persistent supervised child process reading a
// live stdin stream (whisper.cpp's own `stream` example wants SDL2 mic
// capture, not piped stdin, and `whisper-cli` has no live-stdin mode at
// all), this adapter re-invokes `whisper-cli` as a short-lived batch spawn
// on a growing/sliding buffer of already-downsampled 16kHz mono PCM16
// audio, on a fixed tick cadence (`tickMs`) — a "sliding-window re-decode"
// (handover Candidate A's own description). Each tick's FULL transcribed
// text for the current window is emitted as a `partial` event that
// REPLACES the previous partial's text (never appended) — this is exactly
// what app/src/lib/engine_bridge.ts already expects (see that module's
// header comment: `update_partial` always receives the event's full
// current text). A window closes (goes `final`) on an explicit `flush()`
// (the client calls this the instant a manual ArrowLeft/ArrowRight speaker
// switch happens — ties transcription turn boundaries to the same manual
// turn-taking the rest of the app already uses, see mic_engine.ts) or,
// as a safety valve against an unbounded buffer/reprocessing cost if the
// user never switches speakers, once `windowCapMs` of audio has
// accumulated.
//
// Known, named (not silently glossed) limitation: spawning `whisper-cli`
// per tick reloads its ~150MB ggml model on every invocation. Real-time
// throughput at a 1-2s tick cadence is unlikely to be achievable this way
// — `whisper-server`'s whole reason to exist is a resident, already-loaded
// model. This adapter deliberately does NOT also implement a whisper-server
// HTTP client path (a second, equally-unverifiable code path against a
// binary that also isn't installed here) — see the handover's Candidate A
// write-up and this task's result report for the tradeoff. `tickMs` is
// configurable specifically so a real-install session can tune it once
// actual per-invocation latency is known.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcm16_to_wav } from './wav.mjs';

export const DEFAULT_TICK_MS = 1500;
export const DEFAULT_WINDOW_CAP_MS = 20000;
export const DEFAULT_MAX_WINDOW_BYTES = 20 * 16000 * 2; // ~20s of 16kHz mono PCM16
export const DEFAULT_WHISPER_TIMEOUT_MS = 8000;
export const DEFAULT_STALE_MS = 120000;
// live-subtitles handover: "words on screen while the sentence is still
// being spoken" is judged on time-to-first-rendered-word, not time-to-
// transcript. The bug this constant fixes: `setInterval(tick, tickMs)`
// below starts at `create()` — during `POST /api/mic/start`, before the
// client's `getUserMedia`/capture setup has produced a single byte — so
// the FIRST tick's timing is pure luck; the first real audio can land a
// few ms before an interval fires (fast) or a full `tickMs` after it just
// fired (slow, and 1500ms of dead air reads as "broken" per the
// handover). `firstWindowMs` decouples the first decode from that
// interval entirely: `append()` schedules ONE short, DATA-triggered timer
// the instant the first byte of a fresh window lands, and steady-state
// ticking (better context per decode, not latency-critical once the user
// has already seen a word) resumes on `tickMs` after that. Deliberately
// not too short (see `schedule_first_tick`'s doc comment): a window with
// no complete word yet just re-decodes silence/a syllable fragment,
// wasting the "fast" slot on an empty-text tick that gets dropped
// downstream (`mic_engine.ts`'s `handle_server_event` skips blank text).
export const DEFAULT_FIRST_WINDOW_MS = 900;
const BYTES_PER_SECOND = 16000 * 2; // 16kHz mono PCM16 — matches wav.mjs's fixed format

/**
 * @typedef {{ tStart: number; tEnd: number; text: string; final: boolean; decodeMs?: number }} MicStreamEvent
 * @typedef {(event: MicStreamEvent) => void} MicStreamListener
 * @typedef {(wavBytes: Buffer, ctx: { bin: string; model: string }) => Promise<string>} WhisperRunFn
 */

/**
 * `TALKWEAVE_WHISPER_BIN` env override, else `whisper-cli` on PATH — the
 * same default name router.mjs's pre-existing `default_whisper_check`
 * already looked for.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolve_whisper_bin(env = process.env) {
  const raw = env.TALKWEAVE_WHISPER_BIN;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'whisper-cli';
}

/**
 * True iff `bin` resolves to an executable — `which <bin>` when `bin` has
 * no path separator (works for a bare PATH-relative name AND an absolute
 * path, `which` accepts both), matching router.mjs's pre-existing
 * `default_whisper_check` shell-out convention exactly. Never throws.
 * @param {string} bin
 * @returns {boolean}
 */
export function check_bin_available(bin) {
  try {
    const result = spawnSync('which', [bin]);
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * `TALKWEAVE_WHISPER_MODEL` env override, else
 * `~/Library/Application Support/TalkWeave/models/ggml-base.bin`
 * (multilingual — NOT a `.en` model, since German+English conversations
 * are this project's actual use case, per the handover).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function default_model_path(env = process.env) {
  const raw = env.TALKWEAVE_WHISPER_MODEL;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return join(homedir(), 'Library', 'Application Support', 'TalkWeave', 'models', 'ggml-base.bin');
}

/**
 * `TALKWEAVE_WHISPER_TICK_MS` env override, else `DEFAULT_TICK_MS` —
 * exposed as a knob for a real-install session to tune once actual
 * per-invocation `whisper-cli` latency is known (see README's "Known
 * limitation" note in the v0.2 section). A non-finite/non-positive
 * override is ignored rather than producing a zero/negative interval.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolve_tick_ms(env = process.env) {
  const raw = Number(env.TALKWEAVE_WHISPER_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TICK_MS;
}

/**
 * `TALKWEAVE_WHISPER_FIRST_WINDOW_MS` env override, else
 * `DEFAULT_FIRST_WINDOW_MS` — same override shape as `resolve_tick_ms`,
 * exposed separately because the right value for "how long to wait
 * before the very first decode" and "how often to re-decode afterward"
 * are different tradeoffs (first-word latency vs. steady-state accuracy/
 * spawn cost) that a real-install session may want to tune independently.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolve_first_window_ms(env = process.env) {
  const raw = Number(env.TALKWEAVE_WHISPER_FIRST_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FIRST_WINDOW_MS;
}

/**
 * First `models/ggml-*.bin` found directly under `repoRoot`, sorted for
 * determinism, or `null` if the directory doesn't exist or has no match.
 * Manual `readdirSync` filter rather than a glob library/API — no runtime
 * dependency, no reliance on Node's still-experimental `fs.globSync`.
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function find_repo_model(repoRoot) {
  const modelsDir = join(repoRoot, 'models');
  let entries;
  try {
    entries = readdirSync(modelsDir);
  } catch {
    return null;
  }
  const match = entries.filter((f) => f.startsWith('ggml-') && f.endsWith('.bin')).sort()[0];
  return match ? join(modelsDir, match) : null;
}

/**
 * Resolves the model path to actually check/use: env override or the
 * `~/Library/...` default if that file exists, else the repo's
 * `models/ggml-*.bin` fallback if ONE exists, else the originally
 * resolved (env-or-default) path anyway — reported even when missing, so
 * the UI/README message names the exact path that was looked for.
 * @param {{ env?: NodeJS.ProcessEnv; repoRoot?: string; fileExists?: (p: string) => boolean }} [options]
 * @returns {{ model: string; modelPresent: boolean }}
 */
export function resolve_whisper_model(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const primary = default_model_path(env);
  if (fileExists(primary)) return { model: primary, modelPresent: true };

  if (options.repoRoot) {
    const repoMatch = find_repo_model(options.repoRoot);
    if (repoMatch && fileExists(repoMatch)) return { model: repoMatch, modelPresent: true };
  }

  return { model: primary, modelPresent: false };
}

/**
 * `GET /api/whisper/available`'s full answer (router.mjs's
 * `handle_whisper_available`): `available` mirrors the ORIGINAL v0.1
 * contract (binary found on PATH) so no existing caller's assumption
 * silently changes meaning; `modelPresent` is new in v0.2, reported
 * separately so the settings drawer can distinguish "brew1 install
 * whisper-cpp" from "model missing" instead of collapsing both into one
 * disabled label.
 * @param {{ env?: NodeJS.ProcessEnv; repoRoot?: string; binCheck?: (bin: string) => boolean; fileExists?: (p: string) => boolean }} [options]
 * @returns {{ available: boolean; bin: string; model: string; modelPresent: boolean }}
 */
export function check_whisper_availability(options = {}) {
  const env = options.env ?? process.env;
  const binCheck = options.binCheck ?? check_bin_available;
  const bin = resolve_whisper_bin(env);
  const available = binCheck(bin);
  const { model, modelPresent } = resolve_whisper_model({
    env,
    repoRoot: options.repoRoot,
    fileExists: options.fileExists
  });
  return { available, bin, model, modelPresent };
}

/**
 * Real `WhisperRunFn`: writes `wavBytes` to a temp file, spawns
 * `ctx.bin -m ctx.model -f <tmp> -nt -l auto`, and returns the
 * concatenated, trimmed stdout as the transcribed text. `-nt` suppresses
 * whisper-cli's default per-segment `[hh:mm:ss --> hh:mm:ss]` timestamp
 * prefix (documented whisper.cpp flag; UNVERIFIED against a real binary
 * on this machine — see module header). `-l auto` for language
 * auto-detection (German+English conversations, multilingual model, no
 * fixed language). Never throws: a spawn error, non-zero exit, or the
 * `timeoutMs` watchdog firing all resolve `''` (a `tick()`'s "nothing new
 * to say this round" case, not treated as `unavailable` — this function
 * has no such concept; the caller's own `whisper-cli` PATH check at
 * session-start is the actual availability gate). The temp file is always
 * removed, success or failure.
 * `ctx.timeoutMs` overrides `DEFAULT_WHISPER_TIMEOUT_MS` — real callers
 * never set it (the registry's tick/flush paths call this with just
 * `{bin, model}`); it exists as a test seam so the watchdog-kill path can
 * be exercised against a deliberately slow stub binary without a real
 * test waiting out the full production timeout.
 * @type {(wavBytes: Buffer, ctx: { bin: string; model: string; timeoutMs?: number }) => Promise<string>}
 */
export async function default_whisper_run(wavBytes, ctx) {
  const tmpPath = join(tmpdir(), `talkweave-mic-${randomUUID()}.wav`);
  try {
    await writeFile(tmpPath, wavBytes);
  } catch {
    return '';
  }

  try {
    return await new Promise((resolve) => {
      let settled = false;
      /** @param {string} text */
      const finish = (text) => {
        if (settled) return;
        settled = true;
        resolve(text);
      };

      let child;
      try {
        child = spawn(ctx.bin, ['-m', ctx.model, '-f', tmpPath, '-nt', '-l', 'auto'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        finish('');
        return;
      }

      let out = '';
      child.stdout?.on('data', (chunk) => {
        out += chunk.toString('utf-8');
      });
      child.on('error', () => finish(''));
      child.on('close', () => finish(out.trim()));

      const watchdog = setTimeout(() => {
        child.kill('SIGKILL');
      }, ctx.timeoutMs ?? DEFAULT_WHISPER_TIMEOUT_MS);
      child.on('close', () => clearTimeout(watchdog));
    });
  } finally {
    await rm(tmpPath, { force: true });
  }
}

/**
 * One live mic-transcription session's mutable state + tick/flush/stop
 * behavior. Not exported directly — `create_mic_stream_registry` is the
 * public surface; kept as a factory function (not a class) to match this
 * codebase's prevailing style (session_store_core.ts, ollama.mjs, etc all
 * favor factory functions over classes).
 * @param {{ bin: string; model: string; whisperRun: WhisperRunFn; tickMs: number; windowCapMs: number; maxWindowBytes: number; firstWindowMs: number }} config
 */
function create_stream_state(config) {
  const startedAtMs = Date.now();
  /** @type {Buffer[]} */
  let pcmChunks = [];
  let pcmBytes = 0;
  let windowStartMs = startedAtMs;
  let busy = false;
  let lastActivityMs = startedAtMs;
  /** @type {Set<MicStreamListener>} */
  const listeners = new Set();
  // Fast first-tick state (see `DEFAULT_FIRST_WINDOW_MS`'s doc comment) —
  // one live per OPEN window, cleared and re-armed every time a window
  // resets (flush, or the windowCapMs safety valve) so a fast first word
  // is not just a session-start perk but happens for every fresh turn.
  let firstTickScheduled = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let firstTickTimer = null;

  /** @param {MicStreamEvent} event */
  function emit(event) {
    for (const listener of listeners) listener(event);
  }

  function now_s() {
    return (Date.now() - startedAtMs) / 1000;
  }
  function window_start_s() {
    return (windowStartMs - startedAtMs) / 1000;
  }

  /** Drops oldest bytes once over `maxWindowBytes`, advancing
   *  `windowStartMs` by the dropped duration — this is what makes the
   *  window a genuine SLIDING window (bounded reprocessing cost) rather
   *  than an ever-growing one when the user never switches speakers. */
  function enforce_cap() {
    if (pcmBytes <= config.maxWindowBytes) return;
    let overflow = pcmBytes - config.maxWindowBytes;
    while (overflow > 0 && pcmChunks.length > 0) {
      const first = pcmChunks[0];
      if (first.length <= overflow) {
        pcmChunks.shift();
        pcmBytes -= first.length;
        overflow -= first.length;
        windowStartMs += (first.length / BYTES_PER_SECOND) * 1000;
      } else {
        pcmChunks[0] = first.subarray(overflow);
        pcmBytes -= overflow;
        windowStartMs += (overflow / BYTES_PER_SECOND) * 1000;
        overflow = 0;
      }
    }
  }

  /** Arms the fast first-tick timer, at most once per open window
   *  (`firstTickScheduled` guards a burst of `append()` calls in the same
   *  window from stacking up several timers). Not simply "tick sooner":
   *  a genuine data-triggered one-shot, independent of wherever the
   *  steady-state `setInterval` below happens to be in its own cycle. */
  function schedule_first_tick() {
    if (firstTickScheduled) return;
    firstTickScheduled = true;
    firstTickTimer = setTimeout(() => {
      firstTickTimer = null;
      void tick();
    }, config.firstWindowMs);
  }

  /** Cancels a pending fast-first-tick timer and clears the "already
   *  scheduled this window" flag — called on every window reset so the
   *  NEXT window's first byte re-arms it, and on `stop()` so a lingering
   *  timer never fires into a torn-down stream. */
  function clear_first_tick() {
    if (firstTickTimer) {
      clearTimeout(firstTickTimer);
      firstTickTimer = null;
    }
    firstTickScheduled = false;
  }

  /** @param {Buffer} buf */
  function append(buf) {
    if (buf.length === 0) return;
    const windowWasEmpty = pcmBytes === 0;
    pcmChunks.push(buf);
    pcmBytes += buf.length;
    lastActivityMs = Date.now();
    enforce_cap();
    // Only the byte that OPENS a window schedules anything — every later
    // append in the same window just keeps growing the buffer the
    // already-armed (or already-fired) first tick will read.
    if (windowWasEmpty) schedule_first_tick();
  }

  function reset_window() {
    pcmChunks = [];
    pcmBytes = 0;
    windowStartMs = Date.now();
    clear_first_tick();
  }

  /** Runs whisper on whatever's currently buffered; resolves the
   *  transcribed text, `''` if nothing is buffered (skips the spawn
   *  entirely — the common case for a flush with nothing new). */
  async function transcribe_current_window() {
    if (pcmBytes === 0) return '';
    const wav = pcm16_to_wav(Buffer.concat(pcmChunks, pcmBytes));
    return config.whisperRun(wav, { bin: config.bin, model: config.model });
  }

  /** Scheduled tick: one partial re-decode of the current window, or —
   *  once `windowCapMs` has elapsed since the window opened — that same
   *  decode promoted to `final` and the window reset (the safety-valve
   *  boundary described in this module's header comment).
   *
   * live-transcription-visibility fix ("how long the last decode actually
   * took, if you can measure it, so a slow model reads as slow"): wraps
   * `transcribe_current_window()` with a plain wall-clock measurement and
   * rides it along on the SAME event as `decodeMs` — no new SSE event
   * type, no router.mjs change, `app/src/lib/mic_engine.ts` just reads an
   * extra optional field off the payload it already parses. Always a real
   * spawn-to-resolve duration here specifically because `tick()`'s own
   * guard above already refuses to run with `pcmBytes === 0` — there is
   * no fast-path-skipped-the-spawn case to accidentally report as `0`. */
  async function tick() {
    if (busy || pcmBytes === 0) return;
    busy = true;
    try {
      const decodeStartedAt = Date.now();
      const text = await transcribe_current_window();
      const decodeMs = Date.now() - decodeStartedAt;
      const overCap = Date.now() - windowStartMs >= config.windowCapMs;
      const event = { tStart: window_start_s(), tEnd: now_s(), text, final: overCap, decodeMs };
      emit(event);
      if (overCap) reset_window();
    } finally {
      busy = false;
    }
  }

  /** Forces the current window to close now (manual speaker switch, or
   *  session stop): re-decodes whatever's buffered one last time (more
   *  accurate than reusing a stale partial), emits it as `final`
   *  (empty text if nothing was ever buffered this window — callers on
   *  the client side drop empty finals rather than opening a spurious
   *  segment), then resets. Waits out a tick already in flight first
   *  rather than racing it.
   *
   * Unlike `tick()`, `flush()` is reachable with `pcmBytes === 0` (a
   * manual speaker switch with nothing buffered yet) — `transcribe_
   * current_window()`'s own fast path skips the spawn entirely in that
   * case, so `decodeMs` is omitted from the event rather than reported as
   * a dishonest `0`. */
  async function flush() {
    while (busy) await new Promise((r) => setTimeout(r, 10));
    busy = true;
    try {
      const hadAudio = pcmBytes > 0;
      const decodeStartedAt = Date.now();
      const text = await transcribe_current_window();
      /** @type {MicStreamEvent} */
      const event = { tStart: window_start_s(), tEnd: now_s(), text, final: true };
      if (hadAudio) event.decodeMs = Date.now() - decodeStartedAt;
      emit(event);
      reset_window();
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, config.tickMs);

  return {
    append,
    flush,
    /** @param {MicStreamListener} l */
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    stop() {
      clearInterval(timer);
      clear_first_tick();
      listeners.clear();
    },
    get lastActivityMs() {
      return lastActivityMs;
    },
    touch() {
      lastActivityMs = Date.now();
    }
  };
}

/**
 * Creates the server-side registry of live mic-transcription streams —
 * router.mjs's mic routes (`POST /api/mic/start|audio/:id|flush/:id|stop/:id`,
 * `GET /api/mic/stream/:id`) are handed ONE instance of this via
 * `options.micRegistry` (server.mjs constructs it once at startup;
 * per-test files construct a fresh one each, so no state leaks across
 * tests — same seam pattern as `options.whisperCheck`/`options.ollamaGenerate`,
 * called out explicitly since router.mjs's own header comment claims it
 * holds no disk/process state itself: this registry is where that state
 * actually lives).
 * @param {{ bin?: string; model?: string; whisperRun?: WhisperRunFn; tickMs?: number; windowCapMs?: number; maxWindowBytes?: number; firstWindowMs?: number; staleMs?: number; sweepMs?: number }} [options]
 */
export function create_mic_stream_registry(options = {}) {
  const config = {
    bin: options.bin ?? resolve_whisper_bin(),
    model: options.model ?? default_model_path(),
    whisperRun: options.whisperRun ?? default_whisper_run,
    tickMs: options.tickMs ?? resolve_tick_ms(),
    windowCapMs: options.windowCapMs ?? DEFAULT_WINDOW_CAP_MS,
    maxWindowBytes: options.maxWindowBytes ?? DEFAULT_MAX_WINDOW_BYTES,
    firstWindowMs: options.firstWindowMs ?? resolve_first_window_ms()
  };
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  /** @type {Map<string, ReturnType<typeof create_stream_state>>} */
  const streams = new Map();

  /** Periodic sweep for streams a client abandoned without ever calling
   *  `/api/mic/stop/:id` (a crashed tab, a dropped connection with no
   *  `pagehide` firing) — `sweepMs: 0` disables it, so tests never leak
   *  an open `setInterval` handle past their own teardown. */
  let sweepTimer = null;
  const sweepMs = options.sweepMs ?? 30000;
  if (sweepMs > 0) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, stream] of streams) {
        if (now - stream.lastActivityMs > staleMs) {
          stream.stop();
          streams.delete(id);
        }
      }
    }, sweepMs);
    sweepTimer.unref?.();
  }

  return {
    /** @returns {string} the new stream's id */
    create() {
      const id = randomUUID();
      streams.set(id, create_stream_state(config));
      return id;
    },
    /** @param {string} id @param {Buffer} buf @returns {boolean} */
    append_audio(id, buf) {
      const stream = streams.get(id);
      if (!stream) return false;
      stream.append(buf);
      return true;
    },
    /** @param {string} id @returns {Promise<boolean>} */
    async flush(id) {
      const stream = streams.get(id);
      if (!stream) return false;
      await stream.flush();
      return true;
    },
    /** @param {string} id @returns {boolean} */
    stop(id) {
      const stream = streams.get(id);
      if (!stream) return false;
      stream.stop();
      streams.delete(id);
      return true;
    },
    /** @param {string} id @param {MicStreamListener} listener @returns {(() => void) | null} */
    subscribe(id, listener) {
      const stream = streams.get(id);
      if (!stream) return null;
      stream.touch();
      return stream.subscribe(listener);
    },
    /** @param {string} id @returns {boolean} */
    has(id) {
      return streams.has(id);
    },
    /** Test/shutdown cleanup: stops every stream and the sweep timer. */
    stop_all() {
      for (const stream of streams.values()) stream.stop();
      streams.clear();
      if (sweepTimer) clearInterval(sweepTimer);
    }
  };
}
