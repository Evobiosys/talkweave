// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure interval-summary scheduling decision (Task 9). Kept
// framework-free so it's directly unit-testable, same rationale as
// session_store_core.ts. app.svelte polls this on a fixed real-time
// cadence rather than setting/resetting a `setInterval` keyed to
// `summaryIntervalMinutes` itself, so a live change to that setting
// (settings_drawer.svelte) takes effect on the very next poll without any
// timer-teardown/rebuild plumbing — same "read fresh" instinct as
// replay_engine.ts's `get_speed()`.

/**
 * True iff an interval-triggered summary should fire right now:
 * `intervalMinutes` is a positive number, and at least that many minutes
 * of session-elapsed time have passed since the last summary's `tTo` (or
 * since session start, `lastSummaryEndT = 0`, if none exists yet).
 * `intervalMinutes <= 0` (settings_store_core.ts's "0 = off") always
 * returns false, as does any non-finite input (defensive against a
 * not-yet-settled clock read).
 */
export function should_fire_interval_summary(nowT: number, lastSummaryEndT: number, intervalMinutes: number): boolean {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return false;
  if (!Number.isFinite(nowT) || !Number.isFinite(lastSummaryEndT)) return false;
  return nowT - lastSummaryEndT >= intervalMinutes * 60;
}
