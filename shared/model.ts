// SPDX-License-Identifier: AGPL-3.0-or-later

// shared/model.ts
//
// Core data model for a talkweave session. This module is isomorphic
// (imported by both the Svelte app and, later, the server) and has no
// runtime dependencies beyond the language itself.
//
// Times (`t`, `tStart`, `tEnd`, `tFrom`, `tTo`) are seconds from session
// start, as floats.
//
// Entity ids are generated with `next_id(prefix, existing)`: segments use
// prefix "s" (s1, s2, ...), flags "f" (f1, ...), notes "n" (n1, ...),
// summaries "sm" (sm1, ...), fact-checks "fc" (fc1, ...).

export type Speaker = 'L' | 'R';

export interface Segment {
  id: string;
  speaker: Speaker | null;
  tStart: number;
  tEnd: number;
  text: string;
  final: boolean;
}

export interface Flag {
  id: string;
  t: number;
  by: Speaker;
  segmentId: string | null;
  claimText: string | null;
  charStart: number | null;
  charEnd: number | null;
  source: 'key' | 'dblclick' | 'ai';
}

export interface Note {
  id: string;
  t: number;
  by: Speaker;
  text: string;
}

export interface Summary {
  id: string;
  tFrom: number;
  tTo: number;
  text: string;
  trigger: 'interval' | 'manual';
}

export interface FactCheck {
  id: string;
  t: number;
  by: Speaker;
  question: string;
  quick: { text: string; model: string; ms: number } | null;
  deep: {
    status: 'running' | 'done' | 'dismissed';
    text: string | null;
    model: string;
    etaMs: number | null;
    contradicts: boolean;
  } | null;
}

/**
 * v0.3's pause/resume record (train-fixes Part B). `tStart` is the
 * session-clock `t` (same timeline as every other entity's `t`/`tStart`)
 * at which the pause began. `tEnd` is `null` while the pause is still
 * open (never resumed) — once resumed, it is set to `tStart + <real
 * wall-clock seconds the pause lasted>`, NOT another session-clock
 * reading: the whole point of "recorder elapsed excludes paused time"
 * (audio_recorder.ts) is that the session clock itself does not advance
 * during a pause, so a second session-clock reading taken at resume time
 * would equal `tStart` again and could never express how long the pause
 * actually lasted. `tEnd - tStart` is therefore the pause's real
 * duration in seconds, which is exactly what the transcript divider
 * (transcript_view.svelte) and the export (server/lib/export.mjs) show.
 */
export interface Pause {
  id: string;
  tStart: number;
  tEnd: number | null;
}

export interface Session {
  id: string;
  startedAt: string;
  title: string;
  names: { L: string; R: string };
  segments: Segment[];
  flags: Flag[];
  notes: Note[];
  summaries: Summary[];
  factChecks: FactCheck[];
  pauses: Pause[];
  audioFile: string | null;
}

/**
 * Returns the next unused id for `prefix` given the ids already in use for
 * that same entity kind (e.g. all current segment ids when minting a new
 * segment id). Only ids that are exactly `prefix` followed by one or more
 * digits count — so prefix "s" never matches an id like "sm1" belonging to
 * a different entity kind. Starts at 1 when no matching id exists yet.
 */
export function next_id(prefix: string, existing: string[]): string {
  const re = new RegExp(`^${escape_regexp(prefix)}(\\d+)$`);
  let max = 0;
  for (const id of existing) {
    const m = re.exec(id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

function escape_regexp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
