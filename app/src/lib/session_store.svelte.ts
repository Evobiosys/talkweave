// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — Svelte 5 runes-based live session store.
//
// All actual mutation logic lives in session_store_core.ts (plain TS, no
// runes) so it's unit-testable under vitest without the svelte plugin —
// see that file's header comment. This class is a thin reactive shell: its
// `$state` fields are named/typed to structurally satisfy core's
// `StoreState` interface, so every method just forwards `this` into the
// matching core function, then (except for set_speaker — see below)
// notifies the autosave controller.
//
// `session: Session = $state()!` — the non-null assertion is deliberate:
// `$state()` with no argument types as `T | undefined`, but the
// constructor always assigns a real Session before the store is used
// (verified via svelte-check), so the assertion just tells TS what's
// already true rather than papering over a real gap.

import type { FactCheck, Flag, Session, Speaker } from '../../../shared/model';
import { serialize_session } from '../../../shared/session_md';
import { create_autosave_controller, type AutosaveController } from './autosave';
import * as core from './session_store_core';
import type {
  FlagClaimUpdate,
  NewFactCheckInput,
  NewFlagInput,
  NewNoteInput,
  NewSegmentInput,
  NewSummaryInput,
  PartialUpdate
} from './session_store_core';

const AUTOSAVE_DEBOUNCE_MS = 2000;

export class SessionStore {
  session: Session = $state()!;
  dirty: number = $state(0);
  currentSpeaker: Speaker | null = $state(null);

  private autosave: AutosaveController;

  /**
   * Task 5's `on_flag_created` hook — see that method below. Plain array,
   * not `$state`: callback identities aren't UI state, nothing renders off
   * this list, so making it reactive would just add tracking overhead for
   * no benefit (YAGNI).
   */
  private flagCreatedCallbacks: Array<(flag: Flag) => void> = [];

  constructor(initial: Session) {
    this.session = initial;
    this.autosave = create_autosave_controller(() => this.save(), AUTOSAVE_DEBOUNCE_MS);
  }

  add_segment(input: NewSegmentInput): string {
    const id = core.add_segment(this, input);
    this.autosave.notify();
    return id;
  }

  update_partial(id: string, patch: PartialUpdate): boolean {
    const changed = core.update_partial(this, id, patch);
    if (changed) this.autosave.notify();
    return changed;
  }

  add_flag(input: NewFlagInput): string {
    const id = core.add_flag(this, input);
    this.autosave.notify();
    const flag = this.session.flags.find((f) => f.id === id);
    if (flag) {
      for (const cb of this.flagCreatedCallbacks) {
        try {
          cb(flag);
        } catch (err) {
          // A misbehaving subscriber (e.g. Task 9's AI claim pipeline)
          // must never break flag creation itself.
          console.error('[talkweave] on_flag_created callback threw', err);
        }
      }
    }
    return id;
  }

  /**
   * Registers `callback` to run with the newly created `Flag` every time
   * `add_flag` succeeds (after the mutation and the autosave notify).
   * Task 9's AI claim-extraction pipeline uses this to queue newly
   * flagged points for the Ollama claim API without `add_flag` itself
   * knowing anything about AI/network concerns — see task-5-brief.md
   * ("Flag markers also queue for LLM claim extraction ... leave a
   * pending_ai hook") and task-9-brief.md. Returns an unregister function.
   */
  on_flag_created(callback: (flag: Flag) => void): () => void {
    this.flagCreatedCallbacks.push(callback);
    return () => {
      const idx = this.flagCreatedCallbacks.indexOf(callback);
      if (idx !== -1) this.flagCreatedCallbacks.splice(idx, 1);
    };
  }

  add_note(input: NewNoteInput): string {
    const id = core.add_note(this, input);
    this.autosave.notify();
    return id;
  }

  set_title(title: string): void {
    core.set_title(this, title);
    this.autosave.notify();
  }

  set_names(patch: Partial<Session['names']>): void {
    core.set_names(this, patch);
    this.autosave.notify();
  }

  /**
   * Task 6's header recording dot contract: a plain boolean, defaulting
   * false, that Task 7's audio pipeline sets true while actively recording
   * and false otherwise. Deliberately NOT `$state`-backed through
   * session_store_core.ts / persisted in `Session` — it's ephemeral
   * runtime UI state (whether the mic/replay engine is currently running),
   * not something `session_md.ts` serializes, so it doesn't bump `dirty`
   * or trigger autosave. Task 7 sets `store.recording = true/false`
   * directly; app.svelte reads it to drive `session_header.svelte`'s dot.
   */
  recording: boolean = $state(false);

  /**
   * Sets the current speaker. Bumps `dirty` (see session_store_core.ts)
   * but deliberately does NOT schedule an autosave: `currentSpeaker` has no
   * field in Session/session_md.ts, so this never changes what would be
   * written to disk.
   */
  set_speaker(speaker: Speaker | null): void {
    core.set_speaker(this, speaker);
  }

  add_summary(input: NewSummaryInput): string {
    const id = core.add_summary(this, input);
    this.autosave.notify();
    return id;
  }

  add_fact_check(input: NewFactCheckInput): string {
    const id = core.add_fact_check(this, input);
    this.autosave.notify();
    return id;
  }

  set_fact_check_quick(id: string, quick: NonNullable<FactCheck['quick']>): boolean {
    const changed = core.set_fact_check_quick(this, id, quick);
    if (changed) this.autosave.notify();
    return changed;
  }

  set_fact_check_deep(id: string, deep: NonNullable<FactCheck['deep']>): boolean {
    const changed = core.set_fact_check_deep(this, id, deep);
    if (changed) this.autosave.notify();
    return changed;
  }

  flags_for(by: Speaker): Flag[] {
    return core.flags_for(this, by);
  }

  /** Task 9: applies the AI claim pipeline's result to an existing flag —
   *  see session_store_core.ts's `update_flag_claim` doc comment for why
   *  this replaces the span wholesale rather than patching individual
   *  fields. */
  update_flag_claim(id: string, patch: FlagClaimUpdate): boolean {
    const changed = core.update_flag_claim(this, id, patch);
    if (changed) this.autosave.notify();
    return changed;
  }

  /** Task 7: records that audio has been persisted for this session —
   *  see session_store_core.ts's `set_audio_file` doc comment for why
   *  this must go through the core mutator (dirty bump + autosave)
   *  rather than a direct `this.session.audioFile = ...` assignment. */
  set_audio_file(audioFile: string | null): void {
    core.set_audio_file(this, audioFile);
    this.autosave.notify();
  }

  /** Opens a new pause at session-clock time `t` — see
   *  session_store_core.ts's `start_pause` doc comment. */
  start_pause(t: number): string {
    const id = core.start_pause(this, t);
    this.autosave.notify();
    return id;
  }

  /** Closes the currently-open pause — see session_store_core.ts's
   *  `end_pause` doc comment for why `t` is NOT a fresh session-clock
   *  reading. */
  end_pause(t: number): boolean {
    const changed = core.end_pause(this, t);
    if (changed) this.autosave.notify();
    return changed;
  }

  /** Serializes the current session and PUTs it to the server. Safe to
   *  call directly (autosave uses it via the debounce controller above). */
  async save(): Promise<void> {
    const body = serialize_session(this.session);
    await fetch(`/api/session/${this.session.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body
    });
  }

  /** Cancels any pending debounced autosave and saves immediately — e.g.
   *  on page unload, so the last couple seconds of activity aren't lost. */
  flush(): Promise<void> {
    return this.autosave.flush();
  }
}
