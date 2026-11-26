// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { create_mic_turn_tracker } from '../app/src/lib/mic_engine_core';

describe('create_mic_turn_tracker: basic labeling', () => {
  it('labels partial/final events with the initial speaker when nothing has changed', () => {
    const t = create_mic_turn_tracker('L');
    expect(t.label_event(false)).toBe('L');
    expect(t.label_event(false)).toBe('L');
    expect(t.label_event(true)).toBe('L');
    expect(t.openSpeaker).toBe('L');
  });

  it('starts with openSpeaker null when no speaker has ever been chosen, and label_event reports null', () => {
    const t = create_mic_turn_tracker(null);
    expect(t.openSpeaker).toBeNull();
    expect(t.label_event(false)).toBeNull();
  });
});

describe('create_mic_turn_tracker: request_speaker_change', () => {
  it('returns false (no-op) for a re-press of the already-open speaker', () => {
    const t = create_mic_turn_tracker('L');
    expect(t.request_speaker_change('L')).toBe(false);
    expect(t.openSpeaker).toBe('L');
  });

  it('returns true for an actual change, but does NOT apply it immediately', () => {
    const t = create_mic_turn_tracker('L');
    expect(t.request_speaker_change('R')).toBe(true);
    expect(t.openSpeaker).toBe('L'); // still L — not applied until a final is consumed
  });

  it('a first-ever choice (openSpeaker was null) is APPLIED IMMEDIATELY, not deferred to a final', () => {
    // Regression for the "nothing is ever rendered" bug: null means
    // nobody has been attributed yet, so there is no in-flight real
    // utterance to protect by waiting; deferring here only meant every
    // event before the next final (including that final itself) got
    // labeled null and, at the time this fix shipped, was silently
    // dropped by mic_engine.ts because EngineEvent.speaker was still
    // non-nullable then. See mic_engine_core.ts's "fix round 2" AND "fix
    // round 3" header comments — round 3 later made `speaker: null`
    // renderable instead of undroppable-or-lost, but this module's own
    // no-flush-on-first-choice behavior (asserted below) didn't change.
    const t = create_mic_turn_tracker(null);
    expect(t.request_speaker_change('R')).toBe(false); // reports "not a change" so no flush fires
    expect(t.openSpeaker).toBe('R'); // promoted right away
    expect(t.label_event(false)).toBe('R'); // the very next event is already labeled
  });

  it('a re-press of a speaker that is already pending-from-null is still a no-op', () => {
    const t = create_mic_turn_tracker(null);
    t.request_speaker_change('L');
    expect(t.request_speaker_change('L')).toBe(false);
    expect(t.openSpeaker).toBe('L');
  });
});

describe('create_mic_turn_tracker: the race this module exists to prevent', () => {
  it('a partial in flight when the switch happens still gets labeled with the OLD speaker', () => {
    const t = create_mic_turn_tracker('L');
    expect(t.label_event(false)).toBe('L'); // a partial for L's utterance, already "in flight"

    t.request_speaker_change('R'); // user presses ArrowRight mid-utterance

    // The next event(s) belonging to the SAME (not-yet-final) window still
    // report L — the switch is only a REQUEST until a final consumes it.
    expect(t.label_event(false)).toBe('L');
  });

  it('the final that closes the in-flight utterance still reports the OLD speaker; only the NEXT event gets the new one', () => {
    const t = create_mic_turn_tracker('L');
    t.label_event(false); // L partial
    t.request_speaker_change('R'); // switch requested mid-utterance

    const finalSpeaker = t.label_event(true); // the server's final for L's flushed window
    expect(finalSpeaker).toBe('L');
    expect(t.openSpeaker).toBe('R'); // NOW promoted, after the final was consumed

    expect(t.label_event(false)).toBe('R'); // the new window's first partial
  });

  it('a final with NO pending change just reports openSpeaker and does not alter it', () => {
    const t = create_mic_turn_tracker('L');
    expect(t.label_event(true)).toBe('L'); // e.g. a windowCapMs safety-valve auto-final
    expect(t.openSpeaker).toBe('L');
  });

  it('multiple speaker-change requests before any final land on the LATEST target only', () => {
    const t = create_mic_turn_tracker('L');
    t.request_speaker_change('R');
    t.request_speaker_change('L'); // changed their mind back before the final arrived
    t.request_speaker_change('R'); // and back to R again

    expect(t.label_event(true)).toBe('L'); // the in-flight utterance still L
    expect(t.openSpeaker).toBe('R'); // lands on the latest request, not an intermediate one
  });

  it('a request_speaker_change back to the CURRENTLY pending target mid-flight is a real "change" relative to openSpeaker, still returns true', () => {
    const t = create_mic_turn_tracker('L');
    expect(t.request_speaker_change('R')).toBe(true);
    // openSpeaker is still 'L' (not yet promoted) — requesting 'R' again
    // compares against openSpeaker (still L), so this is correctly still
    // reported as "a change from what's currently open."
    expect(t.request_speaker_change('R')).toBe(true);
  });
});
