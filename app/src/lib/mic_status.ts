// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — live-transcription-visibility fix: "if next time it takes a
// few seconds until it is shown, please say so that it's like starting to
// transcribe or whatever. Make sure that it's honest. It's not just
// saying so." (Jakob, verbatim). Pure string-building only, same
// separation as whisper_status.ts's `live_status_text`/lag_helpers.ts's
// `format_lag_label` — every input here is a real signal mic_engine.ts
// already measures (see MicStatusInputs below for exactly which one), not
// a guess this module invents, so a caller can unit-test the wording
// without any DOM/network involved.
//
// What "real signal" means for each field, and — as important — what was
// deliberately NOT added because it can't be known honestly:
//
//   - `audioStarted`: mic_engine.ts's `on_audio_started` — fires the
//     moment the `ScriptProcessorNode` actually pulls a sample off the
//     mic. Not `getUserMedia` resolving (that only means permission was
//     granted, not that a byte has moved yet).
//   - `hasSegments`: the session's OWN segment list is non-empty
//     (`store.session.segments.length > 0`, read by app.svelte) — not a
//     mic_engine.ts concept at all; "has anything been transcribed" is a
//     question about the transcript, which the store already answers
//     exactly.
//   - `pendingAudio`: mic_engine.ts's `on_pending_audio_change` — true iff
//     audio has been captured more recently than the last SSE event this
//     engine received. This is a fact about what's SITTING IN THE
//     PIPELINE right now, not a claim about whether the server happens to
//     be mid-decode this exact millisecond. A live push of the server's
//     own `busy` flag was considered and rejected: it would need a new SSE
//     event type racing the existing partial/final stream on the SAME
//     connection, which is exactly the kind of thing this module's own
//     header asks not to invent when the truth can't cross the wire
//     cheaply — see whisper_stream.mjs's `tick()`/`flush()` for the
//     `decodeMs` field this DOES ride on the existing event instead.
//     ONLY used pre-first-segment below (see `mic_status_text`'s "once
//     segments exist" comment for why it's deliberately NOT used to decide
//     between "transcribing" and some calmer-sounding alternative once
//     segments exist — headless-Playwright-measured: `ScriptProcessorNode`
//     fires `onaudioprocess` roughly every 85-100ms while `tick()`'s
//     cadence is 900-1500ms, so during real, continuous mic capture this
//     flips back to `true` within about 100ms of every single SSE event —
//     a `false` reading is a sub-100ms artifact of exactly when it's
//     sampled, not a real "the pipe is idle" moment, and asserting
//     anything off it here would flicker on every tick).
//   - `lastDecodeMs`: mic_engine.ts's `on_decode_ms`, itself reading
//     whisper_stream.mjs's own measured `transcribe_current_window()`
//     wall-clock duration. `null` until the first event that carries it.
//   - `stalled`: mic_engine.ts's existing `on_stall_change` (unchanged by
//     this fix) — the SSE pipe itself has gone quiet.
//
// Priority order below (`stalled` first, then `!audioStarted`, then
// `hasSegments`/`pendingAudio`/`lastDecodeMs`) is deliberate: a stalled
// pipe is the one state that's actually alarming and should never be
// masked by a calmer-sounding "waiting for audio" just because the mic
// happened to stop producing samples around the same time.

export interface MicStatusInputs {
  /** Real audio has been captured from the mic at least once this
   *  session — see this module's header comment. */
  audioStarted: boolean;
  /** The session already has at least one segment (attributed or not). */
  hasSegments: boolean;
  /** Audio has been captured more recently than the last transcript event
   *  arrived — see this module's header comment for exactly what this
   *  can and can't claim. */
  pendingAudio: boolean;
  /** Milliseconds the most recent decode actually took, or `null` before
   *  the first measurement (see whisper_stream.mjs's `decodeMs`). */
  lastDecodeMs: number | null;
  /** mic_engine.ts's `on_stall_change` — no SSE event of any kind has
   *  arrived for a while; the pipe itself may be dead. */
  stalled: boolean;
}

/** `Xs` to one decimal place, e.g. `1.8s` — same rounding convention as
 *  lag_helpers.ts's `format_lag_label`. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Builds the one-line, always-honest live-transcription status —
 * rendered persistently for the whole live-mic session (not gated behind
 * "no segments yet", unlike whisper_status.ts's `live_status_text`, which
 * answers a different question: whether an ASR engine is reachable at
 * all, evaluated once before any session-specific signal exists). Every
 * clause here is present ONLY when the matching input says it's true —
 * nothing is asserted the caller can't currently verify.
 */
export function mic_status_text(s: MicStatusInputs): string {
  if (s.stalled) return 'transcription stalled — no output for a while, check the ASR engine';
  if (!s.audioStarted) return 'waiting for audio…';

  const decodeClause = s.lastDecodeMs === null ? null : `last decode ${seconds(s.lastDecodeMs)}`;

  if (!s.hasSegments) {
    if (s.pendingAudio) return 'audio arriving — nothing transcribed yet, first pass in progress';
    return decodeClause ? `audio arriving — nothing transcribed yet (${decodeClause})` : 'audio arriving — nothing transcribed yet';
  }

  // Once segments exist: always "transcribing…", never a "caught up"
  // alternative gated on `pendingAudio`. Measured against a real headless
  // session (continuous mic capture, real qwen3-asr decodes): `pendingAudio`
  // is only ever false for the sub-100ms gap between an SSE event landing
  // and the very next `onaudioprocess` callback, which happens on every
  // single tick during live recording — a status line that alternated on
  // that would flicker roughly once a second, which is a worse dishonesty
  // than the one this whole fix exists to remove (see this module's
  // header comment on `pendingAudio` for the measurement). During live
  // capture there is, as a practical matter, always more audio than has
  // been reflected back yet, so "transcribing…" is simply the true
  // statement for this whole phase, not the vaguer of two options.
  return decodeClause ? `transcribing… (${decodeClause})` : 'transcribing…';
}
