// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure helpers for Task 7's audio recording/bottom-bar/seek
// feature. Kept framework- and browser-API-free (no MediaRecorder, no
// getUserMedia, no DOM types beyond the small structural bits below) so
// they're directly unit-testable under vitest — same rationale as
// transcript_helpers.ts and session_store_core.ts. `audio_recorder.ts`
// (the actual MediaRecorder/getUserMedia adapter, not unit-testable in
// this repo's node-environment vitest config) imports the timebase/mime
// helpers from here rather than duplicating the math; `audio_bar.svelte`
// imports the marker/duration/segment helpers.

import type { FactCheck, Flag, Note, Segment } from '../../../shared/model';

// --- segment lookup ---------------------------------------------------

/**
 * The segment "covering" time `t`, for playback-sync underlining and
 * seek-driven transcript scrolling. Rule (task-7-brief.md's `segment_at(t)`):
 * a segment whose `[tStart, tEnd]` contains `t` wins outright; otherwise,
 * the segment with the greatest `tStart <= t` (i.e. "the one that was
 * playing most recently before `t`") — covers the common "t lands in a
 * silence gap between segments" case, which playback hits constantly.
 * Returns null for an empty list, a non-finite `t`, or a `t` before every
 * segment's `tStart`.
 */
export function segment_at(segments: Segment[], t: number): Segment | null {
  if (!Number.isFinite(t)) return null;
  let candidate: Segment | null = null;
  for (const seg of segments) {
    if (t >= seg.tStart && t <= seg.tEnd) return seg;
    if (seg.tStart <= t && (candidate === null || seg.tStart > candidate.tStart)) candidate = seg;
  }
  return candidate;
}

// --- marker/progress math (t -> %) -------------------------------------

/**
 * `t` as a percentage of `duration`, clamped to `[0, 100]` — the one
 * formula both the progress fill and every tick mark (flags/notes/
 * fact-checks) in `audio_bar.svelte` are positioned with. Non-finite or
 * non-positive `duration` (a fresh live session at t=0, or review mode
 * before the `<audio>` element has resolved a duration) and non-finite
 * `t` both return 0 rather than NaN/Infinity, so a bad input never lands
 * an off-screen or CSS-breaking `left:` value.
 */
export function marker_percent(t: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(t)) return 0;
  const pct = (t / duration) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * A finite duration to drive `marker_percent`/the progress bar with, given
 * the `<audio>` element's own reported `duration` and a `fallback` (see
 * `data_extent_seconds` below). Recorded webm has an indefinite duration
 * in its container header, so Chromium reports `Infinity` for
 * `audio.duration` — reliably during a still-recording session, and
 * sometimes even after a clean stop until the full file has been
 * buffered. Real playback position (`audio.currentTime`) is unaffected
 * and stays accurate regardless; only the *marker/progress-bar math*
 * needs a finite stand-in scale, which is what this resolves.
 */
export function resolve_duration(rawDuration: number, fallback: number): number {
  if (Number.isFinite(rawDuration) && rawDuration > 0) return rawDuration;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

/**
 * The latest timestamp referenced anywhere in the session's data
 * (segment `tEnd`s, flag/note/fact-check `t`s) — the `resolve_duration`
 * fallback for a review session whose `<audio>` duration hasn't resolved
 * to a finite value yet. 0 for a session with no timestamped data at all
 * (an audio file with nothing transcribed/flagged over it yet).
 */
export function data_extent_seconds(session: {
  segments: Segment[];
  flags: Flag[];
  notes: Note[];
  factChecks: FactCheck[];
}): number {
  let max = 0;
  for (const s of session.segments) if (s.tEnd > max) max = s.tEnd;
  for (const f of session.flags) if (f.t > max) max = f.t;
  for (const n of session.notes) if (n.t > max) max = n.t;
  for (const fc of session.factChecks) if (fc.t > max) max = fc.t;
  return max;
}

// --- timebase (recorder-clock / performance.now fallback) --------------

/**
 * Seconds elapsed between two `performance.now()`-style millisecond
 * readings (same monotonic clock the recorder's own start instant and
 * the "no mic" fallback instant are both captured from — see
 * `audio_recorder.ts`'s header comment for why this is *not*
 * `session_clock.ts`'s `Date.parse`-based `session_elapsed_seconds`:
 * that one anchors to `session.startedAt`, a wall-clock ISO timestamp
 * set once at session creation, which task-7-brief.md's "t=0 at record
 * start" explicitly supersedes for a live, mic-available session).
 * Negative deltas (clock read before the recorded start, effectively
 * impossible with a monotonic clock but guarded anyway) clamp to 0
 * rather than going negative, matching `session_elapsed_seconds`'s own
 * clamp.
 */
export function elapsed_seconds(startMs: number, nowMs: number): number {
  const deltaMs = nowMs - startMs;
  return deltaMs > 0 ? deltaMs / 1000 : 0;
}

/**
 * v0.3 train-fixes Part B: the pure pause-clock math behind
 * `audio_recorder.ts`'s `now()` once pause/resume exists — "recorder
 * elapsed excludes paused time" (task requirement). `effectiveNowMs` is
 * `performance.now()` while actively recording, or the frozen instant the
 * pause began (`pausedAtMs`) while paused — the caller decides which,
 * this function just does `elapsed_seconds(startMs, effectiveNowMs) -
 * totalPausedMs`. Passing the *frozen* instant while paused is what makes
 * the elapsed clock stop advancing during a pause without this function
 * needing to know whether it's currently paused at all — same "one seam,
 * caller supplies the right input" pattern as `resolve_current_t` above.
 * Clamped to 0 (never negative) for the same defensive reason
 * `elapsed_seconds` clamps its own delta.
 */
export function elapsed_excluding_paused(startMs: number, effectiveNowMs: number, totalPausedMs: number): number {
  const raw = elapsed_seconds(startMs, effectiveNowMs) - totalPausedMs / 1000;
  return raw > 0 ? raw : 0;
}

/**
 * The "current session time" decision behind app.svelte's `current_t()`
 * seam (fix round 1, task-7-report.md): use the recorder's own clock only
 * once its timebase is actually *established* (`recorderReady` — see
 * `audio_recorder.ts`'s `ready` getter), never merely because a recorder
 * object exists. `create_audio_recorder()` returns synchronously, but its
 * `start()` is async (`getUserMedia`'s permission prompt, mic
 * negotiation) — until that settles, the recorder has neither a real
 * start instant nor a fallback instant, and `recorder.now()` returns a
 * bare 0. Without this check, that 0 would silently mislabel any
 * flag/note created in that window as "t=0" instead of falling through
 * to the wall-clock-since-`startedAt` fallback every other session
 * (review, replay-engine, or simply "recorder not ready yet") already
 * uses.
 */
export function resolve_current_t(recorderReady: boolean, recorderNow: number, fallbackT: number): number {
  return recorderReady ? recorderNow : fallbackT;
}

/**
 * Final review fix, Important 1: the "current session time" for a
 * REVIEW-mode session — one reopened via `'resume'` with a persisted audio
 * file, where `app.svelte`'s `current_t()` never gets a recorder (`plan.
 * startRecorder` is false for `'resume'`) or a replay clock (`plan.
 * replayClock` is false too) to read from. Before this function existed,
 * `current_t()` fell all the way through to `session_elapsed_seconds`
 * (wall-clock time since the session's `startedAt`, i.e. since it was
 * originally CREATED) — for a 3-day-old session that stamps the very first
 * double-click/Space/Shift/note at t ~= 259200, permanently sorting it to
 * the top of the sidebar and pinning the audio-bar marker at 100%.
 *
 * Prefer the actual playback position, `playbackT` (`app.svelte`'s
 * `playbackT`, forwarded from `audio_bar.svelte`'s `<audio>` element via
 * its own `ontimeupdate` — non-null exactly once playback has started at
 * least once this session). Before that (page just opened, nothing played
 * yet), clamp to the session's own data extent (`data_extent_seconds`)
 * rather than any wall-clock reading — worst case, a flag/note lands at
 * the end of the existing transcript instead of at an arbitrary
 * multi-day offset.
 */
export function resolve_review_t(playbackT: number | null, dataExtentSeconds: number): number {
  if (playbackT !== null && Number.isFinite(playbackT)) return playbackT;
  return Number.isFinite(dataExtentSeconds) && dataExtentSeconds > 0 ? dataExtentSeconds : 0;
}

const CANDIDATE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm'];

/**
 * Picks the best supported `MediaRecorder` mime type from
 * `CANDIDATE_MIME_TYPES` (opus-in-webm first, per task-7-brief.md's
 * literal `audio/webm;codecs=opus`; plain `audio/webm` as the fallback),
 * via an injected `isSupported` predicate — `MediaRecorder.isTypeSupported`
 * in the real adapter, a fake in tests. Returns `''` (empty string) when
 * neither is supported, meaning "construct `MediaRecorder` with no
 * `mimeType` option at all and let the browser pick its own default" —
 * passing an unsupported string to the constructor throws, whereas
 * omitting the option never does.
 */
export function pick_mime_type(isSupported: (type: string) => boolean): string {
  for (const type of CANDIDATE_MIME_TYPES) {
    if (isSupported(type)) return type;
  }
  return '';
}
