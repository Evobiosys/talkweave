// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — client-side fetch wrapper for `GET /api/whisper/available`
// (Task 8, server/lib/router.mjs). v0.2 (DEVLOG/v02-live-transcription_
// of-talkweave_handover.md): the route now answers the full `{available,
// bin, model, modelPresent}` shape (whisper_stream.mjs's
// `check_whisper_availability`) instead of a bare boolean, so callers can
// distinguish "whisper-cli not installed" from "installed but no model
// file": settings_drawer.svelte's mic-option label reads this directly,
// and app.svelte's `session_mode_plan` gating reads `mic_ready` (both
// required, not just `available`) to decide whether a live session may
// actually start the real mic engine.
//
// qwen-asr-engine handover (this file's name predates it, kept as-is
// rather than a rename that would touch every importer for no behavior
// change): the server can now pick between more than one ASR backend
// (local Qwen3-ASR proxy, or whisper.cpp; see the handover's "Selection"
// step, owned by the parallel server-side task). This module's contract
// with that task: it ADDS an `engine` field (and may add `detail`) to the
// SAME `/api/whisper/available` payload rather than replacing its shape;
// `bin`/`model`/`modelPresent` keep meaning whatever they meant before.
// Parsed tolerantly below (absent/wrong-typed -> `null`) specifically so
// this client never breaks regardless of the exact field the server task
// lands with. If it used a different name, the fix is a one-line rename
// in `fetch_whisper_status` below, nowhere else: every display string in
// this file goes through `engine_label`/`live_status_text`/
// `mic_option_label`/`engine_indicator_label`, not a raw field read.
//
// Any network/parse failure degrades to the same "not available" shape a
// genuinely-missing install would report, never throwing, matching every
// other client-side fetch wrapper in this codebase (ai_client.ts,
// factcheck_client.ts).

export interface WhisperStatus {
  /** True iff the configured binary/proxy resolves and answers. */
  available: boolean;
  /** The binary path/name that was checked (env `TALKWEAVE_WHISPER_BIN`
   *  override, or `whisper-cli`). */
  bin: string;
  /** The model path that was checked (env `TALKWEAVE_WHISPER_MODEL`
   *  override, the `~/Library/Application Support/TalkWeave/models/
   *  ggml-base.bin` default, or a `models/ggml-*.bin` repo fallback). */
  model: string;
  /** True iff `model` actually exists on disk. */
  modelPresent: boolean;
  /** Which engine the server actually selected/checked, e.g. `'qwen'` or
   *  `'whisper'`, or `null` when the server hasn't reported one (older
   *  server build, or genuinely no engine chosen). Free-form string
   *  rather than a closed union: `engine_label` below already falls back
   *  gracefully to printing an unrecognized value verbatim, which is
   *  safer against a server/client field-value mismatch than a type that
   *  would just be a lie at the type level. */
  engine: string | null;
  /** Optional free-text context from the server (e.g. why an engine isn't
   *  reachable), appended to the "unreachable" message when present. */
  detail: string | null;
}

const UNAVAILABLE_STATUS: WhisperStatus = {
  available: false,
  bin: 'whisper-cli',
  model: '',
  modelPresent: false,
  engine: null,
  detail: null
};

/**
 * Fetches the full whisper availability status. Never throws; a
 * network/parse failure or a malformed response resolves the same
 * conservative "not available" shape a genuine absence would report.
 */
export async function fetch_whisper_status(): Promise<WhisperStatus> {
  try {
    const res = await fetch('/api/whisper/available');
    if (!res.ok) return UNAVAILABLE_STATUS;
    const data = await res.json();
    if (!data || typeof data !== 'object' || data.ok !== true) return UNAVAILABLE_STATUS;
    return {
      available: data.available === true,
      bin: typeof data.bin === 'string' ? data.bin : UNAVAILABLE_STATUS.bin,
      model: typeof data.model === 'string' ? data.model : UNAVAILABLE_STATUS.model,
      modelPresent: data.modelPresent === true,
      engine: typeof data.engine === 'string' && data.engine.trim() ? data.engine : null,
      detail: typeof data.detail === 'string' && data.detail.trim() ? data.detail : null
    };
  } catch {
    return UNAVAILABLE_STATUS;
  }
}

/** Known engine ids mapped to a human-friendly name. Anything else (a
 *  server build ahead of this list, or a value this client doesn't
 *  recognize yet) is printed verbatim rather than hidden: an
 *  unfamiliar-but-honest label beats a silently wrong generic one. */
const ENGINE_LABELS: Record<string, string> = {
  qwen: 'qwen3-asr',
  'qwen3-asr': 'qwen3-asr',
  whisper: 'whisper.cpp',
  'whisper-cli': 'whisper.cpp'
};

/** Human-friendly engine name for display. `null` (engine not reported)
 *  reads as "the local engine" rather than an empty/undefined-looking
 *  string. */
export function engine_label(engine: string | null): string {
  if (!engine) return 'the local engine';
  return ENGINE_LABELS[engine] ?? engine;
}

/**
 * The live-session empty-transcript status line (transcript_view.svelte,
 * shown only while `isLiveSession` and no segments have arrived yet).
 * v0.2 shipped a static, now-false claim ("live transcription arrives in
 * v0.2"); this replaces it with an honest line driven by the server's own
 * availability payload, keeping the original three-clause cadence
 * ("recording. <engine state>. flags, notes and audio are captured.") so
 * only the middle clause actually changes meaning.
 */
export function live_status_text(status: WhisperStatus): string {
  const engineClause = mic_ready(status)
    ? `listening: ${engine_label(status.engine)}`
    : status.available
      ? `${engine_label(status.engine)} reachable, not ready yet`
      : `no transcription engine reachable${status.detail ? `, ${status.detail}` : ''}`;
  return `recording. ${engineClause}. flags, notes and audio are captured.`;
}

/** settings_drawer.svelte's `<select>` label for the 'mic' option: same
 *  three states the v0.2 three-state label distinguished (not installed /
 *  installed-but-not-ready / ready), now naming whichever engine the
 *  server actually picked instead of assuming whisper. */
export function mic_option_label(status: WhisperStatus): string {
  if (mic_ready(status)) return `mic: ${engine_label(status.engine)}`;
  if (status.available) return `mic (${engine_label(status.engine)} reachable, not ready, see README)`;
  return 'mic (no ASR engine reachable, see README)';
}

/** Small, always-on header chip (app.svelte, "near the existing chips")
 *  naming the configured engine regardless of session mode. Informational
 *  even during a demo/review session, since it reflects the app's own ASR
 *  configuration, not anything about the session currently open (same
 *  "independent of the current session" status as `whisperStatus` itself,
 *  fetched once at shell mount). */
export function engine_indicator_label(status: WhisperStatus): string {
  if (mic_ready(status)) return `asr: ${engine_label(status.engine)}`;
  if (status.available) return `asr: ${engine_label(status.engine)} (not ready)`;
  return 'asr: unreachable';
}

/** True only once BOTH the binary and the model file are confirmed
 *  present: the one condition that actually permits starting a real mic
 *  engine (handover step 6: gracefully degrade otherwise). Binary-only
 *  availability is real progress (worth its own settings-drawer label)
 *  but not enough to transcribe anything. */
export function mic_ready(status: WhisperStatus): boolean {
  return status.available && status.modelPresent;
}

/** Back-compat convenience for any caller that only cares about the
 *  binary being on PATH (the original v0.1 contract's exact meaning). */
export async function fetch_whisper_available(): Promise<boolean> {
  const status = await fetch_whisper_status();
  return status.available;
}
