// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure mutation logic for the live session store.
//
// Extracted out of session_store.svelte.ts so it's unit-testable under
// plain vitest. `vitest.config.ts` has no @sveltejs/vite-plugin-svelte
// wired in, so `$state`/`$derived` (Svelte 5 compiler macros, not real JS)
// don't compile when a `.svelte.ts` module is imported directly by a test
// — every function here is therefore plain TypeScript operating on a
// `StoreState`-shaped plain object, with no rune anywhere in this file.
//
// `session_store.svelte.ts`'s `SessionStore` class declares its `session`/
// `dirty`/`currentSpeaker` fields with exactly these names and types, so it
// structurally satisfies `StoreState` and can pass `this` straight into
// every function below — no mutation logic is duplicated between the
// tested core and the real reactive store.

import { next_id } from '../../../shared/model';
import type { FactCheck, Flag, Note, Pause, Segment, Session, Speaker, Summary } from '../../../shared/model';

export interface StoreState {
  session: Session;
  dirty: number;
  currentSpeaker: Speaker | null;
}

export interface NewSegmentInput {
  speaker: Speaker | null;
  tStart: number;
  tEnd: number;
  text: string;
  final: boolean;
}

export function add_segment(state: StoreState, input: NewSegmentInput): string {
  const id = next_id(
    's',
    state.session.segments.map((s) => s.id)
  );
  const segment: Segment = { id, ...input };
  state.session.segments.push(segment);
  state.dirty += 1;
  return id;
}

export interface PartialUpdate {
  tEnd?: number;
  text?: string;
  final?: boolean;
  speaker?: Speaker | null;
}

/**
 * Patches an existing segment in place — the shape a live streaming
 * transcript uses to grow a segment's text/tEnd as more audio is
 * transcribed, finalizing it once done. Returns false (no-op, no dirty
 * bump) when `id` doesn't match any segment.
 */
export function update_partial(state: StoreState, id: string, patch: PartialUpdate): boolean {
  const seg = state.session.segments.find((s) => s.id === id);
  if (!seg) return false;
  Object.assign(seg, patch);
  state.dirty += 1;
  return true;
}

export interface NewFlagInput {
  t: number;
  by: Speaker;
  segmentId: string | null;
  claimText: string | null;
  charStart: number | null;
  charEnd: number | null;
  source: Flag['source'];
}

export function add_flag(state: StoreState, input: NewFlagInput): string {
  const id = next_id(
    'f',
    state.session.flags.map((f) => f.id)
  );
  const flag: Flag = { id, ...input };
  state.session.flags.push(flag);
  state.dirty += 1;
  return id;
}

export interface NewNoteInput {
  t: number;
  by: Speaker;
  text: string;
}

export function add_note(state: StoreState, input: NewNoteInput): string {
  const id = next_id(
    'n',
    state.session.notes.map((n) => n.id)
  );
  const note: Note = { id, ...input };
  state.session.notes.push(note);
  state.dirty += 1;
  return id;
}

/**
 * Sets the current speaker for manual turn-taking (ArrowLeft/ArrowRight per
 * global-constraints.md's key map — Task 5 owns wiring the keys
 * themselves). Bumps `dirty` per the brief's literal "every mutation bumps
 * a dirty counter", even though `currentSpeaker` has no field in
 * Session/session_md.ts and therefore never changes what autosave would
 * persist — the store wrapper deliberately does NOT schedule an autosave
 * for this one mutation. See task-3-report.md for the ruling.
 */
export function set_speaker(state: StoreState, speaker: Speaker | null): void {
  state.currentSpeaker = speaker;
  state.dirty += 1;
}

export interface NewSummaryInput {
  tFrom: number;
  tTo: number;
  text: string;
  trigger: Summary['trigger'];
}

export function add_summary(state: StoreState, input: NewSummaryInput): string {
  const id = next_id(
    'sm',
    state.session.summaries.map((s) => s.id)
  );
  const summary: Summary = { id, ...input };
  state.session.summaries.push(summary);
  state.dirty += 1;
  return id;
}

export interface NewFactCheckInput {
  t: number;
  by: Speaker;
  question: string;
}

export function add_fact_check(state: StoreState, input: NewFactCheckInput): string {
  const id = next_id(
    'fc',
    state.session.factChecks.map((f) => f.id)
  );
  const fc: FactCheck = { id, ...input, quick: null, deep: null };
  state.session.factChecks.push(fc);
  state.dirty += 1;
  return id;
}

/** Returns false (no-op, no dirty bump) when `id` doesn't match any fact-check. */
export function set_fact_check_quick(state: StoreState, id: string, quick: NonNullable<FactCheck['quick']>): boolean {
  const fc = state.session.factChecks.find((f) => f.id === id);
  if (!fc) return false;
  fc.quick = quick;
  state.dirty += 1;
  return true;
}

/** Returns false (no-op, no dirty bump) when `id` doesn't match any fact-check. */
export function set_fact_check_deep(state: StoreState, id: string, deep: NonNullable<FactCheck['deep']>): boolean {
  const fc = state.session.factChecks.find((f) => f.id === id);
  if (!fc) return false;
  fc.deep = deep;
  state.dirty += 1;
  return true;
}

/**
 * Sets the session title (Task 6's session-header editable title). Always
 * bumps `dirty` — matches `set_speaker`'s "every mutation bumps dirty"
 * convention above — even for a same-value re-set, since detecting a no-op
 * here isn't worth the complexity for a plain string field (YAGNI).
 */
export function set_title(state: StoreState, title: string): void {
  state.session.title = title;
  state.dirty += 1;
}

/**
 * Patches `session.names` (Task 6's settings-drawer L/R name fields).
 * Partial by design: a single input's `oninput` only ever changes its own
 * side, so the caller passes just that side rather than reconstructing the
 * whole `{L, R}` pair on every keystroke.
 */
export function set_names(state: StoreState, patch: Partial<Session['names']>): void {
  if (patch.L !== undefined) state.session.names.L = patch.L;
  if (patch.R !== undefined) state.session.names.R = patch.R;
  state.dirty += 1;
}

/**
 * Records that audio has been persisted for this session (Task 7's
 * upload contract — `audioFile: 'audio.webm'` once the recorder's first
 * upload lands, matching the server's `AUDIO_FILE` constant). Always
 * bumps `dirty`, same convention as `set_title`/`set_names`, so the next
 * autosave actually writes `audioFile` into session.md — without that, a
 * page reload mid-recording would still read `audioFile: null` from the
 * saved file and app.svelte's live-vs-review decision (made once, at
 * session-ready, from exactly this field) would wrongly take the live/
 * record branch forever instead of review/playback.
 */
export function set_audio_file(state: StoreState, audioFile: string | null): void {
  state.session.audioFile = audioFile;
  state.dirty += 1;
}

export interface FlagClaimUpdate {
  segmentId: string | null;
  claimText: string | null;
  charStart: number | null;
  charEnd: number | null;
  /**
   * Only set (to `'ai'`) when the claim genuinely came from the LLM
   * (task-9-brief.md's `via: 'llm'` case) — flips the flag's `source` so
   * side_panel.svelte's "ai" glyph reflects "a real model produced this
   * span," not just "the AI pipeline touched it." A `via: 'fallback'`
   * update (pure local sentence-extraction, no model involved) omits this
   * field, leaving `source` at whatever it already was (still
   * 'key'/'dblclick') — the flag's span still gets upgraded from
   * whole-segment to a precise range, it just doesn't earn the glyph.
   */
  source?: Flag['source'];
}

/**
 * Task 9's AI claim-extraction pipeline calls this once `/api/llm/claim`
 * answers for a newly created flag, replacing the flag's `segmentId`/
 * `claimText`/`charStart`/`charEnd` wholesale (not a partial patch): the
 * server resolves its own target segment independently of whatever the
 * flag originally pointed at (see server/lib/claim.mjs's header comment),
 * so `charStart`/`charEnd` are only ever meaningful together with the
 * `segmentId` they were computed against — updating the span without also
 * updating `segmentId` would risk slicing the WRONG segment's text
 * (transcript_helpers.ts's `highlighted_ranges` looks up ranges by
 * `flag.segmentId`). Returns false (no-op, no dirty bump) when `id`
 * doesn't match any flag.
 */
export function update_flag_claim(state: StoreState, id: string, patch: FlagClaimUpdate): boolean {
  const flag = state.session.flags.find((f) => f.id === id);
  if (!flag) return false;
  flag.segmentId = patch.segmentId;
  flag.claimText = patch.claimText;
  flag.charStart = patch.charStart;
  flag.charEnd = patch.charEnd;
  if (patch.source !== undefined) flag.source = patch.source;
  state.dirty += 1;
  return true;
}

/**
 * v0.3 train-fixes Part B: opens a new pause at session-clock time `t`
 * (`Pause.tEnd: null` until `end_pause` closes it — see shared/model.ts's
 * `Pause` doc comment for why `tEnd` is NOT another session-clock reading).
 * Callers (app.svelte's pause-button handler) are responsible for calling
 * `audioRecorder.pause()` around this — this function only records the
 * fact for persistence/display, same separation as every other mutator
 * here knowing nothing about audio/DOM concerns.
 */
export function start_pause(state: StoreState, t: number): string {
  const id = next_id(
    'p',
    state.session.pauses.map((p) => p.id)
  );
  const pause: Pause = { id, tStart: t, tEnd: null };
  state.session.pauses.push(pause);
  state.dirty += 1;
  return id;
}

/**
 * Closes the currently-open pause (the one with `tEnd === null`, if any)
 * by setting its `tEnd` to `t` — the caller (app.svelte) computes `t` as
 * `openPause.tStart + <real wall-clock seconds paused>`, not a fresh
 * session-clock reading (see `start_pause`'s doc comment and shared/
 * model.ts's `Pause`). A no-op (no dirty bump) when there is no open
 * pause, mirroring every other "id doesn't match anything" mutator's
 * `false` return here.
 */
export function end_pause(state: StoreState, t: number): boolean {
  const open = state.session.pauses.find((p) => p.tEnd === null);
  if (!open) return false;
  open.tEnd = t;
  state.dirty += 1;
  return true;
}

/**
 * Flags attributed to `by`, sorted newest-first (descending `t`).
 * Recomputed on every call rather than memoized: `flags_for` takes a
 * parameter, so it can't be a plain `$derived` value in the runes store
 * either, and v0.1's flag counts are small enough that memoization isn't
 * worth the complexity (YAGNI).
 */
export function flags_for(state: StoreState, by: Speaker): Flag[] {
  return state.session.flags.filter((f) => f.by === by).sort((a, b) => b.t - a.t);
}
