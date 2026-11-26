<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — one side panel: the flags AND notes a person (`side`) has
  // created, newest first, interleaved chronologically and sized/dimmed
  // per task-5-brief.md's recency rhythm ("like the unlocking-housing
  // pitch column rhythm: airy, white-on-black, generous line-height") —
  // the 3 most recent entries render full size, older ones progressively
  // smaller and dimmer (see flag_helpers.ts's `tier_for_index`), across
  // the *combined* flags+notes list (a recent note counts toward "recent"
  // same as a recent flag).
  //
  // Task 6 adds: the note input at the bottom (Enter commits via
  // `note_helpers.ts`'s `decide_note_commit`, Escape blurs) and note
  // entries in the list above it. Task 12 (Jakob feedback 2026-08-22)
  // removes the ">1-word input" hint entirely — the input just indicates
  // that writing is possible (dim "…" placeholder, subtle bottom border),
  // nothing prescriptive about length.
  //
  // Task 12 also removes the "nothing yet" empty-state copy: an empty
  // panel stays visually empty (no placeholder text of its own) rather
  // than announcing its emptiness.
  //
  // Task 9 adds: a tiny "ai" glyph next to a flag entry's timestamp when
  // `flag.source === 'ai'` — set only when the claim-extraction pipeline's
  // result was genuinely `via: 'llm'` (session_store_core.ts's
  // `update_flag_claim` doc comment), never for a `'fallback'` result.
  //
  // Task 10 adds: fact-check entries that the user has explicitly "kept"
  // (task-10-brief.md: "keep ... pins result into the flagging person's
  // sidebar") — app.svelte is the one that decides WHICH fact-checks reach
  // this component at all (it pre-filters `factChecks` down to `by ===
  // side` AND kept; see app.svelte's `keptFactCheckIds`), so this
  // component just renders whatever it's handed, same as flags/notes.
  //
  // Store-agnostic by design (same pattern as transcript_view.svelte):
  // takes plain data + `onjump`/`onnote` callback props rather than
  // reading a SessionStore directly, so app.svelte stays the one place
  // that wires components to the store.

  import type { FactCheck, Flag, Note, Segment, Speaker } from '../../../shared/model';
  import { excerpt_for, tier_for_index, truncate } from './flag_helpers';
  import { decide_note_commit } from './note_helpers';
  import type { NewNoteInput } from './session_store_core';
  import { format_ts } from './transcript_helpers';

  let {
    side,
    name = '',
    flags,
    notes,
    factChecks = [],
    segments,
    now,
    onjump,
    onnote
  }: {
    side: Speaker;
    /** Task-1 (v0.3 train fixes): `store.session.names[side]`, live from
     *  settings_drawer/session_header edits. Empty string (the default,
     *  before either side has been named) renders no header at all —
     *  "non-default" per the plan means simply truthy. */
    name?: string;
    flags: Flag[];
    notes: Note[];
    /** Already filtered by the caller to this side's KEPT fact-checks only
     *  (see header comment) — defaults to `[]` so existing call sites (and
     *  tests) that predate Task 10 keep compiling/rendering unchanged. */
    factChecks?: FactCheck[];
    segments: Segment[];
    /** Current session-elapsed seconds, read fresh at Enter-press time —
     *  the same "current t" source the flag-creation path uses
     *  (session_clock.ts's `session_elapsed_seconds`, via app.svelte). A
     *  required prop (not optional) so a missed wiring at either
     *  <SidePanel> call site fails svelte-check rather than silently
     *  timestamping notes at 0. */
    now: () => number;
    /** Called with the clicked flag. app.svelte's contract (documented in
     *  transcript_view.svelte): scroll+flash the transcript to the flag's
     *  segment (when it has one) and call `onseek(flag.t)`. Notes have no
     *  segment to jump to, so only flag entries are clickable. */
    onjump?: (flag: Flag) => void;
    /** Called with a new note to persist (`by` already set to `side`) when
     *  the input commits. app.svelte forwards this to `store.add_note`. */
    onnote?: (input: NewNoteInput) => void;
  } = $props();

  type Entry =
    | { t: number; kind: 'flag'; flag: Flag }
    | { t: number; kind: 'note'; note: Note }
    | { t: number; kind: 'factcheck'; factCheck: FactCheck };

  // Combined, newest-first — a defensive re-sort even though
  // flags_for(side)/session.notes are already produced in a sane order
  // upstream, same rationale as the pre-Task-6 `sorted` derivation this
  // replaces: this component never silently misrenders if fed unsorted
  // input from elsewhere.
  const entries = $derived(
    [
      ...flags.map((flag): Entry => ({ t: flag.t, kind: 'flag', flag })),
      ...notes.map((note): Entry => ({ t: note.t, kind: 'note', note })),
      ...factChecks.map((factCheck): Entry => ({ t: factCheck.t, kind: 'factcheck', factCheck }))
    ].sort((a, b) => b.t - a.t)
  );

  let noteText = $state('');

  function commit_note(): void {
    const note = decide_note_commit(noteText, side, now());
    if (note === null) return; // empty/whitespace-only input: no-op
    onnote?.(note);
    noteText = '';
  }

  function handle_note_keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit_note();
    } else if (event.key === 'Escape') {
      (event.currentTarget as HTMLInputElement).blur();
    }
  }
</script>

{#if name}
  <div class="side-panel-name">{name}</div>
{/if}

<div class="side-panel-list" data-side={side}>
  {#each entries as entry, i (entry.kind === 'flag' ? entry.flag.id : entry.kind === 'note' ? entry.note.id : entry.factCheck.id)}
    {#if entry.kind === 'flag'}
      <button type="button" class="entry tier-{tier_for_index(i)}" onclick={() => onjump?.(entry.flag)}>
        <span class="entry-text">{excerpt_for(entry.flag, segments)}</span>
        <span class="entry-meta">
          <span class="entry-time">{format_ts(entry.flag.t)}</span>
          {#if entry.flag.source === 'ai'}
            <span class="ai-glyph" title="AI-extracted claim">ai</span>
          {/if}
        </span>
      </button>
    {:else if entry.kind === 'note'}
      <div class="entry entry-note tier-{tier_for_index(i)}">
        <span class="entry-text">{entry.note.text}</span>
        <span class="entry-time">{format_ts(entry.note.t)}</span>
      </div>
    {:else}
      <div class="entry entry-factcheck tier-{tier_for_index(i)}" class:contradicts={entry.factCheck.deep?.contradicts === true}>
        <span class="entry-text">{truncate(entry.factCheck.question)}</span>
        <span class="entry-meta">
          <span class="entry-time">{format_ts(entry.factCheck.t)}</span>
          {#if entry.factCheck.deep?.contradicts === true}
            <span class="warn-glyph" title="deep check found a contradiction">⚠</span>
          {/if}
        </span>
      </div>
    {/if}
  {/each}
</div>

<div class="note-input-row">
  <input
    class="note-input"
    type="text"
    placeholder="…"
    bind:value={noteText}
    onkeydown={handle_note_keydown}
  />
</div>

<style>
  .side-panel-name {
    color: #6a6a66;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 14px;
  }

  .side-panel-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .entry {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    padding: 2px 0 2px 10px;
    text-align: left;
    cursor: pointer;
    color: #e8e8e4;
    transition:
      border-left-color 120ms ease-out,
      color 120ms ease-out;
  }

  .entry:hover {
    border-left-color: #ffb84d;
    color: #ffb84d;
  }

  .entry-note {
    cursor: default;
    font-style: italic;
  }

  .entry-note:hover {
    border-left-color: transparent;
    color: #e8e8e4;
  }

  .entry-text {
    line-height: 1.6;
  }

  .entry-meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .entry-time {
    color: #6a6a66;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .ai-glyph {
    color: #ffb84d;
    opacity: 0.65;
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border: 1px solid rgba(255, 184, 77, 0.4);
    border-radius: 3px;
    padding: 0 3px;
    line-height: 1.4;
  }

  .entry-factcheck {
    cursor: default;
  }

  .entry-factcheck:hover {
    border-left-color: transparent;
    color: #e8e8e4;
  }

  .entry-factcheck.contradicts {
    border-left-color: #ff6b6b;
  }

  .warn-glyph {
    color: #ff6b6b;
    font-size: 10px;
  }

  .tier-0 {
    font-size: 14px;
    opacity: 1;
  }

  .tier-1 {
    font-size: 13px;
    opacity: 0.78;
  }

  .tier-2 {
    font-size: 12px;
    opacity: 0.6;
  }

  .tier-3 {
    font-size: 11.5px;
    opacity: 0.46;
  }

  .tier-4 {
    font-size: 11px;
    opacity: 0.34;
  }

  .note-input-row {
    margin-top: 20px;
    padding-top: 12px;
    border-top: 1px solid #1a1a1a;
  }

  .note-input {
    width: 100%;
    background: none;
    border: none;
    border-bottom: 1px solid #2a2a26;
    color: #e8e8e4;
    font-size: 12px;
    font-family: inherit;
    padding: 4px 2px;
  }

  .note-input::placeholder {
    color: #4a4a46;
  }

  .note-input:focus {
    outline: none;
    border-bottom-color: #ffb84d;
  }
</style>
