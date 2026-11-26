// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — v0.2 live transcription. Pure turn-tracking state machine
// for mic_engine.ts, split out for the same reason session_mode_plan.ts
// and audio_helpers.ts are split out from their thin wiring counterparts:
// this is exactly where a subtle bug would hide (and did, in this task's
// first design pass — see below), so it needs to be a plain, directly
// unit-testable function, not buried inside fetch/SSE/AudioContext
// plumbing.
//
// The bug this exists to make structurally impossible: `mic_engine.ts`
// stamps every `EngineEvent.speaker` from whatever the manual ArrowLeft/
// ArrowRight keymap most recently set (handover step 4: "reflect whatever
// currentSpeaker the... keymap has set at the moment the utterance
// starts"). If that were a live read of `store.currentSpeaker` at the
// moment each SSE event arrives, a speaker switch mid-utterance would
// mislabel the OUTGOING speaker's final words with the INCOMING speaker
// — the switch happens synchronously, but the server's `final` event for
// the utterance-in-progress only arrives after a network round trip
// later. The fix: `notify_speaker_change`'s target speaker is held as
// PENDING, not applied immediately — `label_event(true)` (a `final`
// event) is the only thing that ever promotes it to `openSpeaker`, so
// every event belonging to the utterance that was already in flight when
// the switch happened keeps reporting the speaker who was actually
// talking during it.
//
// Fix round 2 (the "nothing is ever rendered" bug): the deferred-
// promotion rule above is only correct when `openSpeaker` is a REAL
// speaker whose in-flight utterance needs protecting from being
// relabeled early. It was being applied unconditionally, including to
// the very first ArrowLeft/ArrowRight press of a session (`openSpeaker`
// starting `null`, meaning no speaker has ever been chosen yet, see
// `create_mic_turn_tracker`'s doc comment). There is no "outgoing
// speaker's in-flight utterance" to protect in that case; nobody was
// attributed yet, so deferring was pure, needless data loss: every
// `EngineEvent` is non-nullable on `speaker` (shared/engine.ts), so
// mic_engine.ts's `handle_server_event` silently drops any event labeled
// `null`. Concretely: `request_speaker_change` used to also report "an
// actual change" (`true`) for null->speaker, which made mic_engine.ts
// fire a server-side flush, forcibly ending the CURRENT window and
// splitting the utterance in two at the exact moment the user claimed a
// speaker. The already-buffered half (everything said before the
// keypress) then finalized under the still-null `openSpeaker` and was
// dropped forever; only the flush-triggered final's OWN label snapshot
// (also null, since promotion happens after that snapshot is taken, same
// as any other final) was lost too, so a first-ever speaker choice could
// never be recovered from: not "delayed," genuinely gone. `request_
// speaker_change` now special-cases null->speaker: promote `openSpeaker`
// IMMEDIATELY (no pending, no pretending there's a final to wait for) and
// report "not a change" (`false`), so mic_engine.ts skips the flush
// entirely. With no flush, the server-side window is never split; it
// keeps growing exactly as it already was, and the very next tick's
// partial (still the SAME window, same `tStart`) now carries the newly
// chosen speaker and the FULL text transcribed since the turn began,
// including whatever was said before the speaker was ever claimed. A
// switch between two already-real speakers is untouched: that path still
// defers to the next final, per the original bug this module documents
// above.
//
// Fix round 3 (live-transcription-visibility fix): the "so mic_engine.ts's
// `handle_server_event` silently drops any event labeled `null`" clause
// above described a REAL consequence of `EngineEvent.speaker` being
// non-nullable at the time, but drew the wrong lesson from it — dropping
// was never actually required, it was just the only option available
// while the type forbade expressing "no speaker yet." `shared/engine.ts`'s
// `EngineEvent.speaker` is now `Speaker | null` (matching `shared/
// model.ts`'s `Segment.speaker`, which was ALREADY nullable), and
// `mic_engine.ts`'s `handle_server_event` no longer drops a `null`-labeled
// event — it emits it, and engine_bridge.ts renders it as a real,
// unattributed segment (transcript_view.svelte's existing centered/dimmed
// treatment), then promotes that SAME open segment in place the instant
// this tracker's `label_event` first reports a real speaker for it,
// rather than duplicating or losing the words said before the keypress.
// This module's own behavior is UNCHANGED by that fix: `openSpeaker` still
// starts `null`, still promotes immediately (no flush) on a first-ever
// choice, and a real speaker-to-speaker switch still defers to the next
// final exactly as above — only the caller's now-false assumption that a
// `null` label meant "must not emit" has been corrected, at the layer that
// was actually wrong to assume it.

import type { Speaker } from '../../../shared/model';

export interface MicTurnTracker {
  /** The speaker any CURRENTLY open turn (partial events, and the very
   *  next final) should be stamped with. `null` until a speaker has ever
   *  been chosen (ArrowLeft/ArrowRight never pressed this session) — see
   *  this module's "Fix round 3" header comment: `EngineEvent.speaker`
   *  (shared/engine.ts) is now `Speaker | null` too, so the mic engine
   *  emits exactly this value, `null` included, rather than withholding
   *  the event. */
  readonly openSpeaker: Speaker | null;
  /**
   * Called whenever the manual ArrowLeft/ArrowRight keymap sets a new
   * speaker. Returns `true` iff this is an actual change the caller
   * should flush the server-side transcription window for: `false` for
   * a no-op re-press of the already-open speaker, AND for a first-ever
   * choice (`openSpeaker` was `null`, promoted immediately below rather
   * than deferred), since either way `mic_engine.ts` skips the `/api/mic/
   * flush` request, there's nothing worth splitting the window for.
   */
  request_speaker_change(speaker: Speaker | null): boolean;
  /**
   * Called for EVERY incoming SSE event (partial or final), before
   * deciding whether to forward it — returns the speaker to stamp this
   * particular event with. A `final` event both reports `openSpeaker`
   * AND, if a speaker change is pending, promotes it — so the `final`
   * itself (the utterance that was in flight at switch time) still gets
   * the OLD speaker, and only the NEXT event (the new window's first
   * partial) gets the new one.
   */
  label_event(final: boolean): Speaker | null;
}

export function create_mic_turn_tracker(initialSpeaker: Speaker | null): MicTurnTracker {
  let openSpeaker = initialSpeaker;
  let pendingSpeaker: Speaker | null = null;
  let hasPending = false;

  return {
    get openSpeaker() {
      return openSpeaker;
    },
    request_speaker_change(speaker) {
      if (speaker === openSpeaker) return false;
      if (openSpeaker === null) {
        // First-ever choice this session: there is no in-flight
        // utterance under a real speaker to protect (see this module's
        // "fix round 2" header comment), so apply it now instead of
        // waiting for a final that would otherwise be the very thing
        // that loses the audio said before this keypress.
        openSpeaker = speaker;
        return false;
      }
      pendingSpeaker = speaker;
      hasPending = true;
      return true;
    },
    label_event(final) {
      const label = openSpeaker;
      if (final && hasPending) {
        openSpeaker = pendingSpeaker;
        hasPending = false;
        pendingSpeaker = null;
      }
      return label;
    }
  };
}
