// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure helpers for transcript_view.svelte.
//
// Kept framework-free (no runes, no DOM types beyond the small structural
// interfaces below) so they're directly unit-testable under vitest without
// the svelte plugin — same rationale as session_store_core.ts.

import type { Flag, Segment, Speaker } from '../../../shared/model';

export type Alignment = 'left' | 'right' | 'center';

/**
 * The speaker attributed to `segmentId`, or `null` when either the
 * segment isn't found or it genuinely has no speaker yet (`Segment.
 * speaker` is itself nullable — an unattributed transcript passage is a
 * real, rendered state, not an error). Used by the highlight-to-fact-
 * check attribution fix (transcript_view.svelte's `resolve_selection`):
 * the DOM-range -> segment-id resolution stays there (real DOM concerns),
 * this is the pure "given a segment id, what's its speaker" lookup,
 * worth its own tested function rather than an inline `.find` at the
 * call site.
 */
export function speaker_for_segment(segmentId: string | null, segments: Segment[]): Speaker | null {
  if (!segmentId) return null;
  return segments.find((s) => s.id === segmentId)?.speaker ?? null;
}

/**
 * Maps a segment's speaker to its transcript alignment per task-4-brief.md:
 * L -> left, R -> right, unattributed (null) -> center (dimmed by the
 * component's own class, not this helper).
 */
export function alignment_for(speaker: Speaker | null): Alignment {
  if (speaker === 'L') return 'left';
  if (speaker === 'R') return 'right';
  return 'center';
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Decides whether the transcript should be pinned to the bottom after a
 * scroll or content-height change.
 *
 * - Content shorter than the viewport (nothing to scroll): always pinned.
 * - Otherwise: pinned iff the distance from the bottom is within
 *   `threshold` px. Used uniformly from both the scroll handler and the
 *   auto-scroll effect — "should the view be considered pinned right now,
 *   given where it's scrolled to."
 */
export function should_pin(metrics: ScrollMetrics, threshold = 24): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  if (scrollHeight <= clientHeight) return true;
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= threshold;
}

/**
 * Formats seconds as `mm:ss`, floored (never rounded — rounding 59.9 would
 * print the impossible "00:60"). Negative/NaN input clamps to "00:00".
 * Minutes are not capped at 60 (the brief specifies mm:ss only, no hours
 * field), so times past an hour print e.g. "60:00", "125:03".
 */
export function format_ts(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalSeconds = Math.floor(safe);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export interface WordSpan {
  /** The word's own text (no surrounding whitespace). */
  word: string;
  /** Char offset of the word's first character within the original
   *  segment text, in UTF-16 code units — matches `String.prototype.slice`
   *  indexing, which is what Task 5's `text.slice(charStart, charEnd)`
   *  span-highlighting will use. */
  ci: number;
}

/**
 * Splits segment text into non-whitespace "words" with their original char
 * offsets, for one-`<span data-ci>`-per-word rendering. Uses a regex scan
 * (`/\S+/g` + `m.index`) rather than `split(' ')` + a running counter so
 * multi-space runs, tabs, and leading/trailing whitespace never desync the
 * offsets. Offsets are UTF-16 code-unit indices (not code points), matching
 * `.slice()` semantics, so this is correct even across astral characters
 * (e.g. emoji) in the text.
 *
 * Note for anyone diffing rendered DOM against `segment.text`: consecutive
 * spans are joined by a single rendered space regardless of how much
 * whitespace separated the words in the source text, so `data-ci` values
 * point into the *original* text even though the rendered whitespace has
 * been collapsed. That's intentional, not a bug.
 */
export function split_words(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ word: m[0], ci: m.index });
  }
  return spans;
}

// --- Task 5: flag highlighting + dblclick span math -----------------------
//
// Pure char-offset math for transcript_view.svelte's two flag-related
// jobs: (1) computing a claim/word span's charStart/charEnd from a
// dblclick, and (2) computing which char ranges in a segment's text are
// highlighted by existing flags, for amber-tinted rendering. Both stay
// framework-free per this file's header comment.

export interface CharRange {
  charStart: number;
  charEnd: number;
}

/** The geometry transcript_view.svelte's `ondblclickflag` prop reports —
 *  deliberately just the raw span, not a full flag: `by`/`t` are the
 *  caller's job to fill in (see that component's header comment). Kept
 *  here (a plain .ts module) rather than as an `export` inside the
 *  .svelte file's instance script, since only `<script module>` exports
 *  from a .svelte file are guaranteed real JS/type exports — instance-
 *  script exports are prop-shaped, not a safe place for a shared type
 *  another module imports. */
export interface DblclickFlagSpan {
  segmentId: string;
  charStart: number;
  charEnd: number;
}

/** The sidebar "jump to this segment" request contract — see
 *  transcript_view.svelte's header comment for the full rationale
 *  (`nonce` must change on every request, including a repeat click on the
 *  same segment, since `$effect` only re-fires on a changed dependency). */
export interface ScrollRequest {
  segmentId: string;
  nonce: number;
}

/** The span of a single word given its `split_words` offset (`ci`) and
 *  own text — used for the plain "double-click a word, no drag selection"
 *  case. */
export function word_span(ci: number, word: string): CharRange {
  return { charStart: ci, charEnd: ci + word.length };
}

/**
 * Normalizes a raw (possibly backwards, e.g. a right-to-left drag)
 * selection into an ordered, clamped char range within a segment's text
 * of length `textLength`. Returns null for a degenerate result — a
 * collapsed selection, or one that clamps to zero width — so the caller
 * can fall back to the word-based span (`word_span`) instead of creating
 * a zero-width flag.
 */
export function selection_span(rawStart: number, rawEnd: number, textLength: number): CharRange | null {
  const start = Math.max(0, Math.min(rawStart, rawEnd));
  const end = Math.min(textLength, Math.max(rawStart, rawEnd));
  if (end <= start) return null;
  return { charStart: start, charEnd: end };
}

/**
 * Computes the merged, normalized set of char ranges to highlight within
 * one segment's text, from every flag targeting that segment
 * (`flag.segmentId === segmentId`). A flag with `charStart`/`charEnd`
 * both null highlights the *whole* segment (task-5-brief.md: "or whole
 * segment if null span") — the presence of even one such flag makes the
 * whole-segment case win outright over any other flag's narrower span, so
 * merging never needs to reason about a "whole segment" range colliding
 * with a partial one. Otherwise, ranges are clamped to `[0, textLength]`,
 * degenerate (zero/negative-width after clamping) ranges are dropped, and
 * overlapping/touching ranges are merged so overlapping flags render as
 * clean, non-doubled highlighting.
 */
export function highlighted_ranges(segmentId: string, flags: Flag[], textLength: number): CharRange[] {
  const relevant = flags.filter((f) => f.segmentId === segmentId);
  if (relevant.length === 0 || textLength <= 0) return [];

  const wholeSegment = relevant.some((f) => f.charStart === null || f.charEnd === null);
  if (wholeSegment) return [{ charStart: 0, charEnd: textLength }];

  const raw = relevant
    .map((f) => selection_span(f.charStart as number, f.charEnd as number, textLength))
    .filter((r): r is CharRange => r !== null)
    .sort((a, b) => a.charStart - b.charStart);

  const merged: CharRange[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.charStart <= last.charEnd) {
      last.charEnd = Math.max(last.charEnd, r.charEnd);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * True if a word's own `[wordStart, wordEnd)` overlaps any highlighted
 * range — the rule transcript_view.svelte uses to decide per-word amber
 * tinting. Overlap (not full containment) is intentional: a dblclick
 * selection that ends mid-word still colors that whole word, since
 * rendering is word-granular (one `<span data-ci>` per word — see
 * `split_words`'s doc comment) and a partial-word color split would
 * require breaking that established one-span-per-word contract.
 */
export function word_overlaps_ranges(wordStart: number, wordEnd: number, ranges: CharRange[]): boolean {
  return ranges.some((r) => wordStart < r.charEnd && wordEnd > r.charStart);
}
