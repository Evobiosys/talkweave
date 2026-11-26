// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — live-subtitles handover, item 4: "a small, quiet indication
// of how far behind the words are, so a slow model reads as slow rather
// than as broken." Pure string-building only (same separation as
// whisper_status.ts's `live_status_text`/`engine_indicator_label`) — the
// number itself comes from mic_engine.ts's `on_lag_change` (see that
// option's doc comment for what the millisecond value actually measures
// and its precision caveats); this module just decides what a human
// should be shown for it, unit-tested without any DOM/network involved.

/**
 * `null` hides the chip entirely — genuinely live, nothing worth quietly
 * disclosing. Below this, a normal HTTP-round-trip-scale lag would flicker
 * the chip in and out on every tick, which reads as MORE broken than
 * simply not showing a number this small.
 */
const HIDE_BELOW_MS = 300;

/**
 * Formats a lag reading (`mic_engine.ts`'s `on_lag_change`) as a short,
 * quiet label, or `null` when there's nothing worth showing — a negative
 * or tiny lag (the transcript is, for practical purposes, caught up), or
 * a non-finite input (no lag data yet, e.g. before the first SSE event).
 * `~Xm Ys behind` for anything crossing a minute is defensive, not
 * expected in practice — see mic_engine.ts's header comment on why a live
 * mic session's own window is bounded well under that.
 */
export function format_lag_label(lagMs: number): string | null {
  if (!Number.isFinite(lagMs) || lagMs < HIDE_BELOW_MS) return null;

  const totalSeconds = lagMs / 1000;
  if (totalSeconds < 60) return `~${totalSeconds.toFixed(1)}s behind`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `~${minutes}m ${seconds}s behind`;
}
