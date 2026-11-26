// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure text normalization for the highlight-to-fact-check
// prefill feature (`F` key pressed over a real transcript text
// selection, rather than the "F always prefills from the latest flag"
// behavior it now falls back to). Framework-free (no DOM, no runes),
// same rationale as flag_helpers.ts / transcript_helpers.ts: the DOM-
// range -> segment/char-offset resolution stays in transcript_view.
// svelte's `resolve_selection()` (it needs `[data-ci]`/`[data-segment-
// id]` and `window.getSelection()`, real DOM concerns that can't be unit
// tested here without a browser-like environment this project doesn't
// otherwise need) — but what to DO with the resulting raw string is pure
// string math, and worth its own tested module rather than being buried
// inline in app.svelte's key handler.

import { truncate } from './flag_helpers';

/**
 * Sensible cap on how much selected text becomes a fact-check prompt's
 * prefill. Generous compared to flag_helpers.ts's 120-char sidebar
 * excerpt (this text is going into an editable input the user can still
 * trim, not a passive list entry), but a highlight spanning an entire
 * long transcript still needs a ceiling rather than flowing an
 * unbounded string into the question field and the eventual AI prompt.
 */
export const SELECTION_TEXT_MAX = 400;

/**
 * Turns a raw `Selection.toString()` result into fact-check-prompt-ready
 * text. `Selection.toString()` preserves the DOM's own line breaks
 * (a drag selection across a segment that wraps onto several visual
 * lines carries real `\n`s the transcript never actually renders as
 * paragraph breaks), so this collapses every run of whitespace —
 * newlines, tabs, repeated spaces — down to a single space, then trims
 * the ends. A selection that is only whitespace (or empty) normalizes to
 * `''`; callers treat that identically to "no selection at all" and fall
 * back to the latest-flag prefill (task brief requirement 1) rather than
 * opening the prompt pre-filled with nothing meaningful.
 *
 * Truncation reuses flag_helpers.ts's `truncate` (same ellipsis
 * convention as the sidebar excerpts) rather than reimplementing it —
 * one truncation rule for the whole app.
 */
export function normalize_selected_text(raw: string, max: number = SELECTION_TEXT_MAX): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed ? truncate(collapsed, max) : '';
}
