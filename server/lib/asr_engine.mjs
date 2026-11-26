// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — ASR engine selection (see
// DEVLOG/qwen-asr-engine_of-talkweave_handover.md). Picks which
// transcription backend `server/lib/whisper_stream.mjs`'s mic-stream
// registry actually runs, preferring whatever demonstrably works over
// whatever was merely configured: the local Qwen3-ASR proxy stack
// (qwen_asr.mjs) if its upstream answers, else whisper.cpp
// (whisper_stream.mjs) if its binary AND model file are both present,
// else neither — the existing "unavailable" path callers already handle.
//
// Selection happens ONCE, at server startup (server.mjs calls
// `select_asr_engine` a single time and holds the result for the
// process's lifetime) — not re-evaluated per request. Named limitation,
// not an oversight: if the qwen proxy comes up ten seconds after
// talkweave-server does, this process will not notice until restarted.
// What DOES stay live across the process's lifetime is the CHOSEN
// engine's own reachability — the `checkAvailability` function this
// module returns re-probes that same engine on every call (used by
// router.mjs's `/api/whisper/available` and `/api/mic/start` handlers),
// so a qwen proxy that goes down transiently after a successful startup
// selection is correctly reported as unreachable, not silently reported
// stale-available forever.
//
// `TALKWEAVE_ASR_ENGINE` env override: `qwen` or `whisper` forces that
// engine with NO fallback to the other (a forced-but-unusable engine
// reports `engine: 'none'`, same as auto mode exhausting both) — the
// whole point of forcing one is to rule the other out, e.g. to test
// whisper.cpp behavior on a machine where the qwen proxy also happens to
// be running. Anything else, including unset, is `auto`: try qwen, then
// whisper, then none.

import { default_whisper_run, check_whisper_availability } from './whisper_stream.mjs';
import { asr_proxy_run, check_asr_proxy_availability } from './qwen_asr.mjs';

/**
 * @typedef {{ available: boolean; bin: string; model: string; modelPresent: boolean }} AsrAvailability
 * @typedef {(wavBytes: Buffer, ctx: { bin: string; model: string; timeoutMs?: number }) => Promise<string>} WhisperRunFn
 * @typedef {{
 *   mode: 'qwen' | 'whisper' | 'auto';
 *   engine: 'qwen' | 'whisper' | 'none';
 *   bin: string;
 *   model: string;
 *   whisperRun: WhisperRunFn;
 *   checkAvailability: () => Promise<AsrAvailability & { engine: 'qwen' | 'whisper' | 'none' }>;
 * }} AsrEngineSelection
 */

/**
 * `TALKWEAVE_ASR_ENGINE` env override, normalized; any value other than
 * `qwen`/`whisper` (including unset/empty/typo'd) is `auto`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'qwen' | 'whisper' | 'auto'}
 */
export function resolve_asr_engine_mode(env = process.env) {
  const raw = typeof env.TALKWEAVE_ASR_ENGINE === 'string' ? env.TALKWEAVE_ASR_ENGINE.trim().toLowerCase() : '';
  return raw === 'qwen' || raw === 'whisper' ? raw : 'auto';
}

/**
 * Picks and returns the ASR engine to run for the lifetime of this
 * process. Never throws — an availability check that itself fails (a
 * probe function that rejects rather than resolving `{available: false,
 * ...}`) is not swallowed here; `check_asr_proxy_availability` and
 * `check_whisper_availability` already never throw, and any injected test
 * stub is expected to honor that same contract.
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   repoRoot?: string;
 *   checkQwen?: () => Promise<AsrAvailability>;
 *   checkWhisper?: () => AsrAvailability;
 *   makeQwenRun?: (status: AsrAvailability) => WhisperRunFn;
 *   whisperRun?: WhisperRunFn;
 * }} [options]
 * @returns {Promise<AsrEngineSelection>}
 */
export async function select_asr_engine(options = {}) {
  const env = options.env ?? process.env;
  const mode = resolve_asr_engine_mode(env);

  const checkQwen = options.checkQwen ?? (() => check_asr_proxy_availability({ env }));
  const checkWhisper = options.checkWhisper ?? (() => check_whisper_availability({ env, repoRoot: options.repoRoot }));
  const makeQwenRun =
    options.makeQwenRun ?? ((status) => (wavBytes) => asr_proxy_run(wavBytes, { baseUrl: status.bin, model: status.model }));
  const whisperRun = options.whisperRun ?? default_whisper_run;

  // Once an attempt is unusable at startup, this process has no working
  // `whisperRun` wired up for it — `create_mic_stream_registry` was (or
  // will be) built with whichever OTHER engine ended up selected, or with
  // an inert fallback if none did. A LIVE re-probe can still see the
  // failed engine recover later (the qwen proxy restarting, say), but
  // reporting that recovery as `available: true` here would tell
  // `/api/mic/start`'s `available && modelPresent` gate — and the client
  // reading the same payload — that a session can actually start, when
  // this process still has no run path wired to serve it. Pin the
  // reported availability to false for a `none` outcome regardless of
  // what the live probe says; only the diagnostic `bin`/`model` fields
  // (and the underlying reason, surfaced via a real reachability check)
  // stay live.
  /** @param {AsrAvailability} status @returns {AsrAvailability} */
  function force_unavailable(status) {
    return { ...status, available: false, modelPresent: false };
  }

  /** @returns {Promise<{ usable: boolean; selection: AsrEngineSelection }>} */
  async function attempt_qwen() {
    const status = await checkQwen();
    const usable = status.available && status.modelPresent;
    const engine = usable ? 'qwen' : 'none';
    return {
      usable,
      selection: {
        mode,
        engine,
        bin: status.bin,
        model: status.model,
        whisperRun: usable ? makeQwenRun(status) : whisperRun,
        checkAvailability: usable
          ? async () => ({ ...(await checkQwen()), engine })
          : async () => ({ ...force_unavailable(await checkQwen()), engine })
      }
    };
  }

  /** @returns {{ usable: boolean; selection: AsrEngineSelection }} */
  function attempt_whisper() {
    const status = checkWhisper();
    const usable = status.available && status.modelPresent;
    const engine = usable ? 'whisper' : 'none';
    return {
      usable,
      selection: {
        mode,
        engine,
        bin: status.bin,
        model: status.model,
        whisperRun,
        checkAvailability: usable
          ? async () => ({ ...checkWhisper(), engine })
          : async () => ({ ...force_unavailable(checkWhisper()), engine })
      }
    };
  }

  if (mode === 'qwen') return (await attempt_qwen()).selection;
  if (mode === 'whisper') return attempt_whisper().selection;

  // auto: qwen preferred (per the handover's "prefer what actually
  // works" ordering — it is the engine actually intended to carry this
  // app forward), whisper.cpp as the documented fallback, else none.
  const qwenAttempt = await attempt_qwen();
  if (qwenAttempt.usable) return qwenAttempt.selection;
  return attempt_whisper().selection;
}
