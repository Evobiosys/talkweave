// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — the "current session time" source for Task 5's key-flag and
// dblclick-flag creation (`flag.t`), pending Task 7's real audio-based
// timebase.
//
// Design choice (task-5-brief.md's open question: "if no clock exists
// yet, derive current t as the last final segment's tEnd or a
// performance.now()-based session clock — pick the simplest correct thing
// and document it"): wall-clock elapsed time since `session.startedAt`
// (an ISO string set once at session creation, `server/lib/sessions.mjs`'s
// `new Date().toISOString()`). Chosen over the two suggested alternatives:
//   - Segment `tEnd` freezes between transcript updates — a Space press
//     during a pause in speech would read an already-stale, already-past
//     time instead of the actual moment of the keypress.
//   - A bare `performance.now()` clock has no relationship to session
//     start, or to `Segment`/`Flag`'s own `t`/`tStart`/`tEnd` fields,
//     which shared/model.ts documents as "seconds from session start."
//     `Date.now() - startedAt` *is* seconds from session start, so flags
//     created this way are directly comparable to segment times with no
//     extra offset math anywhere downstream (sidebar sort, highlighting).
//
// Task 7 supersedes this with the real audio-recording timebase (elapsed
// time since MediaRecorder start, with its own fallback per that task's
// brief) — this module is a deliberately small placeholder scoped to
// Task 5, not a general-purpose clock abstraction.

/**
 * Seconds elapsed since `startedAt` (an ISO 8601 string), as of `nowMs`
 * (defaults to `Date.now()`). Returns 0 for an unparseable `startedAt` or
 * a negative delta (clock skew / a session that hasn't "started" yet by
 * this reading) rather than NaN or a negative flag time.
 */
export function session_elapsed_seconds(startedAt: string, nowMs: number = Date.now()): number {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return 0;
  const deltaMs = nowMs - startMs;
  return deltaMs > 0 ? deltaMs / 1000 : 0;
}

/**
 * Formats seconds as `hh:mm:ss`, floored (matching `transcript_helpers.ts`'s
 * `format_ts`'s never-round rationale — rounding 59.9s would print an
 * impossible "60" in the seconds field). Task 6's session-header clock
 * (unlike `format_ts`'s transcript-timestamp `mm:ss`, which deliberately
 * lets minutes run past 60) always shows an hours field, per the brief's
 * literal "hh:mm:ss" — hours are zero-padded to 2 digits same as
 * minutes/seconds and simply grow past "99" for a session over ~4 days
 * rather than wrapping, since nothing sessions this tool realistically run
 * that long needs guarding against. Negative/NaN input clamps to
 * "00:00:00".
 */
export function format_hms(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalSeconds = Math.floor(safe);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
