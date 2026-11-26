// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure helpers for side_panel.svelte (the flag sidebar).
// Framework-free (no runes, no DOM), same rationale as
// transcript_helpers.ts: directly unit-testable under vitest.

import type { Flag, Segment } from '../../../shared/model';

const EXCERPT_MAX = 120;

/**
 * Truncates `text` to at most `max` chars, replacing the tail with a
 * single ellipsis character when it doesn't fit (so the *displayed*
 * length, including the ellipsis, never exceeds `max`). Text already
 * within the limit is returned unchanged (no trailing ellipsis added).
 */
export function truncate(text: string, max: number = EXCERPT_MAX): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…'.slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The text shown for one sidebar entry, per task-5-brief.md: the flag's
 * own `claimText` if set (non-empty after trim — Task 9 fills this in
 * later via the AI claim pipeline), else an excerpt of the flagged
 * segment's text, else `'moment'` for an unanchored flag (`segmentId`
 * null, or — defensively — pointing at a segment that no longer exists).
 * Truncated to ~120 chars.
 */
export function excerpt_for(flag: Flag, segments: Segment[], max: number = EXCERPT_MAX): string {
  const claim = flag.claimText?.trim();
  if (claim) return truncate(claim, max);
  const seg = flag.segmentId ? segments.find((s) => s.id === flag.segmentId) : undefined;
  const segText = seg?.text.trim();
  if (segText) return truncate(segText, max);
  return 'moment';
}

/**
 * The most recently created flag (largest `t`), or `null` when `flags` is
 * empty. Task 10's fact-check prompt pre-fills from this — "the latest
 * flagged claim" — reusing the same newest-first ordering convention as
 * `side_panel.svelte`'s own entry list rather than assuming `flags` is
 * already sorted (defensive, matching this file's other helpers).
 */
export function latest_flag(flags: Flag[]): Flag | null {
  if (flags.length === 0) return null;
  return flags.reduce((latest, f) => (f.t > latest.t ? f : latest));
}

/**
 * Visual "tier" for the sidebar's recency rhythm (task-5-brief.md: "3 most
 * recent at full size/opacity, older ones progressively smaller+dimmer").
 * `index` is position in a newest-first list (0 = most recent). The 3
 * most recent entries (index 0-2) are tier 0 (full size/opacity); each
 * position after that steps down one tier, capped at 4 so a long history
 * doesn't shrink to unreadable.
 */
export function tier_for_index(index: number): number {
  if (index < 3) return 0;
  return Math.min(index - 2, 4);
}
