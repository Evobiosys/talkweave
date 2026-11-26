// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — bridges a TranscriptionEngine's pure event stream
// (shared/engine.ts: `{speaker, tStart, tEnd, text, final}` on `'partial'`/
// `'segment'`) onto a SessionStore. This is the "engine emits, app.svelte
// applies to store" split task-8-brief.md asks for: neither replay_engine.ts
// nor mic_engine.ts imports session_store_core.ts or shared/model.ts's
// `Session` — an engine only knows about turns of speech, never about
// segments/ids/dirty-counters.
//
// The one piece of state this bridge owns that a pure event stream can't
// carry itself: shared/engine.ts's `EngineEvent` has no segment id, so
// "is this event growing the currently-open segment, or starting a new
// one" has to be inferred. The rule: an event's `tStart` identifies its
// turn (replay_engine.ts holds a turn's `tStart` fixed across every
// partial/segment tick for that turn — see its header comment); a new
// `tStart` means a new turn, so this bridge opens a fresh segment via
// `add_segment` and remembers its id, growing that same segment via
// `update_partial` for every later event with the same `tStart`, until a
// `final: true` event closes it out and the next new `tStart` opens the
// next one.
//
// v0.2 fix round 1 (Important 1, review of the live-transcription task):
// `handle`'s unconditional `store.set_speaker(event.speaker)` was fine for
// replay_engine.ts, where the fixture IS the sole source of truth for who
// is speaking — but it is WRONG for mic_engine.ts, where a manual
// ArrowLeft/ArrowRight keypress is the sole source of truth and already
// calls `store.set_speaker` itself (app.svelte's keymap dispatch). The
// bug: mic_engine.ts's server-side window flush (triggered the instant a
// manual switch happens — see that module's header comment) still emits
// one LAST event for the OUTGOING turn, correctly labeled with the OLD
// speaker (mic_engine_core.ts's `MicTurnTracker` — that label is right,
// it's the speaker who was actually talking). But if this bridge then
// blindly called `store.set_speaker(oldSpeaker)` on THAT event, it would
// transiently revert `store.currentSpeaker` back to the speaker the user
// just switched AWAY from, for however long it takes the flush's `final`
// to arrive (a real spawn+model-reload round trip) — and any flag/note
// created via `Space`/dblclick in that window reads `store.currentSpeaker`
// live (`listener_for`), so it would be silently misattributed. The fix:
// `driveSpeaker` (default `true`, replay_engine.ts's unchanged behavior)
// — the mic engine's bridge is constructed with `driveSpeaker: false`
// (app.svelte), so ITS events never touch `currentSpeaker` at all; the
// manual keys remain the only writer, exactly as they already are for
// flag attribution generally. See tests/engine_bridge.test.ts's
// "driveSpeaker:false" cases for the reproduced scenario.
//
// Live-transcription-visibility fix (reported: 18 real SSE events with
// correct text arrived and the page rendered nothing at all, because no
// speaker had been claimed yet): `shared/engine.ts`'s `EngineEvent.speaker`
// was non-nullable, so mic_engine.ts had no honest choice but to drop
// every event before the first ArrowLeft/ArrowRight. It's now
// `Speaker | null` — the correct place for that nullability to live is
// the ENGINE layer (only it can genuinely not know yet), not this bridge
// or the store, both of which already accepted `Speaker | null` on a
// segment (`shared/model.ts`'s `Segment.speaker`) from the start. `handle`
// now passes a `null` speaker straight through to `add_segment` like any
// other value — transcript_view.svelte already has a centered/dimmed
// rendering for exactly this case (task-4-brief.md, predates this fix) —
// and tracks that open segment's own `openSpeaker` so that when a REAL
// speaker is later claimed for the SAME still-open turn (same `tStart`),
// `update_partial` promotes it in place instead of leaving the words
// permanently unattributed or opening a duplicate segment. See `handle`'s
// "late attribution" comment below for the guard that keeps this a
// one-way, once-only promotion.

import type { EngineEvent } from '../../../shared/engine';
import type { Speaker } from '../../../shared/model';
import type { NewSegmentInput, PartialUpdate } from './session_store_core';

/** The minimal slice of SessionStore this bridge needs — matches
 *  SessionStore's real method signatures exactly, so the real store
 *  satisfies this structurally with no adapter, same convention as
 *  session_store_core.ts's own `StoreState`. */
export interface EngineBridgeStore {
  add_segment(input: NewSegmentInput): string;
  update_partial(id: string, patch: PartialUpdate): boolean;
  set_speaker(speaker: Speaker | null): void;
}

export interface EngineBridgeOptions {
  /** Whether `handle` should call `store.set_speaker(event.speaker)` at
   *  all. Defaults to `true` — replay_engine.ts's original, unchanged
   *  behavior (the fixture drives `currentSpeaker`, matching v0.1). Pass
   *  `false` for the mic engine: manual ArrowLeft/ArrowRight keys are the
   *  sole source of truth there and must never be transiently overwritten
   *  by a late-arriving engine event for an already-superseded turn — see
   *  this module's header comment. */
  driveSpeaker?: boolean;
}

export interface EngineBridge {
  /** Pass this straight to `engine.on('partial', bridge.handle)` and
   *  `engine.on('segment', bridge.handle)` — the same handler serves both
   *  channels; `event.final` already distinguishes them where it matters. */
  handle(event: EngineEvent): void;
}

export function create_engine_bridge(store: EngineBridgeStore, options: EngineBridgeOptions = {}): EngineBridge {
  const driveSpeaker = options.driveSpeaker ?? true;
  let openSegmentId: string | null = null;
  let openTStart: number | null = null;
  // Live-transcription-visibility fix: the open segment's OWN attributed
  // speaker, tracked separately from `event.speaker` because the two can
  // now legitimately disagree mid-turn — see `handle`'s "late attribution"
  // branch below for why that's the one and only direction this ever
  // patches.
  let openSpeaker: Speaker | null = null;

  function handle(event: EngineEvent): void {
    // `EngineEvent.speaker` is `Speaker | null` (shared/engine.ts) — a
    // `null` from mic_engine.ts means no speaker has ever been chosen yet,
    // which must never overwrite `currentSpeaker` with nothing; replay_
    // engine.ts's fixture always supplies a real speaker, so this guard is
    // a no-op for it in practice.
    if (driveSpeaker && event.speaker !== null) store.set_speaker(event.speaker);

    if (openSegmentId === null || openTStart !== event.tStart) {
      openSegmentId = store.add_segment({
        speaker: event.speaker,
        tStart: event.tStart,
        tEnd: event.tEnd,
        text: event.text,
        final: event.final
      });
      openTStart = event.tStart;
      openSpeaker = event.speaker;
    } else {
      const patch: PartialUpdate = { tEnd: event.tEnd, text: event.text, final: event.final };
      // Late attribution: this turn opened unattributed (mic_engine.ts had
      // no speaker yet — see that module's header comment) and a speaker
      // has since been claimed for the SAME still-open turn (identical
      // `tStart`, so this is definitely a continuation, not a new one).
      // Promote the segment in place — the pending text becomes theirs,
      // rather than being duplicated into a second segment or left
      // permanently unattributed. This is the ONLY direction `speaker`
      // ever gets patched: once `openSpeaker` is a REAL speaker this
      // branch never fires again for the same turn, so a genuine
      // speaker-to-speaker switch mid-utterance (mic_engine_core.ts's
      // deferred-promotion path, which always closes the turn with
      // `final` first — see `create_engine_bridge`'s own final-closes-the-
      // turn handling below) can never relabel an already-attributed
      // segment through here.
      if (openSpeaker === null && event.speaker !== null) {
        patch.speaker = event.speaker;
        openSpeaker = event.speaker;
      }
      store.update_partial(openSegmentId, patch);
    }

    if (event.final) {
      openSegmentId = null;
      openTStart = null;
      openSpeaker = null;
    }
  }

  return { handle };
}
