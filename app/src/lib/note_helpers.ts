// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure helpers for the note input at the bottom of each side
// panel (Task 6). Framework-free (no runes, no DOM), same rationale as
// flag_helpers.ts / transcript_helpers.ts: directly unit-testable under
// vitest.
//
// Task 12 (Jakob feedback 2026-08-22): the input's job is just "commit a
// note on Enter" — the earlier "2s hint on >1-word input" mechanism
// (`should_hint`/`word_count`/`NOTE_HINT_TEXT`/`NOTE_HINT_DURATION_MS`,
// task-6-brief.md's "if >1 word, commit anyway but show a 2s gentle hint")
// is removed entirely per the brief ("REMOVE ... the hint mechanism and
// its copy"). `decide_note_commit` now just decides whether there's
// anything to commit.

import type { NewNoteInput } from './session_store_core';
import type { Speaker } from '../../../shared/model';

/**
 * Decides the outcome of an Enter press in one side panel's note input.
 * `text` is the raw (untrimmed) input value; `by` is that panel's side;
 * `t` is the current session time (session_clock.ts's
 * `session_elapsed_seconds`, the same "current t" source the flag-creation
 * path uses — see keymap.ts / app.svelte). Trims `text` before storing it
 * (leading/trailing whitespace isn't meaningful content for a note).
 * Returns `null` for empty/whitespace-only input — Enter on a blank input
 * is a no-op, not an empty-text Note.
 */
export function decide_note_commit(text: string, by: Speaker, t: number): NewNoteInput | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return { t, by, text: trimmed };
}
