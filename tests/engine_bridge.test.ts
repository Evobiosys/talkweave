// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { create_engine_bridge, type EngineBridgeStore } from '../app/src/lib/engine_bridge';
import type { EngineEvent } from '../shared/engine';
import type { Speaker } from '../shared/model';
import type { NewSegmentInput, PartialUpdate } from '../app/src/lib/session_store_core';

/** Minimal fake store recording every call, so tests can assert exactly
 *  what the bridge did without a real SessionStore/Session. `currentSpeaker`
 *  mirrors the real SessionStore's own field (session_store_core.ts's
 *  `set_speaker` mutates exactly this shape) — added for the
 *  `driveSpeaker:false` tests below, which need to assert the LIVE value
 *  at a point in time, not just the full call history `speakers` already
 *  gives every other test here. */
function fake_store(): EngineBridgeStore & {
  segments: (NewSegmentInput & { id: string })[];
  patches: { id: string; patch: PartialUpdate }[];
  speakers: (Speaker | null)[];
  currentSpeaker: Speaker | null;
} {
  const segments: (NewSegmentInput & { id: string })[] = [];
  const patches: { id: string; patch: PartialUpdate }[] = [];
  const speakers: (Speaker | null)[] = [];
  let nextId = 1;
  const store = {
    segments,
    patches,
    speakers,
    currentSpeaker: null as Speaker | null,
    add_segment(input: NewSegmentInput) {
      const id = `s${nextId++}`;
      segments.push({ ...input, id });
      return id;
    },
    update_partial(id: string, patch: PartialUpdate) {
      patches.push({ id, patch });
      return true;
    },
    set_speaker(speaker: Speaker | null) {
      speakers.push(speaker);
      store.currentSpeaker = speaker;
    }
  };
  return store;
}

function event(overrides: Partial<EngineEvent>): EngineEvent {
  return { speaker: 'L', tStart: 0, tEnd: 1, text: 'hi', final: false, ...overrides };
}

describe('engine_bridge: opening and growing a segment', () => {
  it('opens a new segment on the first event for a turn', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store);

    bridge.handle(event({ tStart: 0, tEnd: 0.5, text: 'a', final: false }));

    expect(store.segments).toHaveLength(1);
    expect(store.segments[0]).toMatchObject({ speaker: 'L', tStart: 0, tEnd: 0.5, text: 'a', final: false });
    expect(store.speakers).toEqual(['L']);
  });

  it('grows the same segment via update_partial for later events with the same tStart', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store);

    bridge.handle(event({ tStart: 0, tEnd: 0.5, text: 'a', final: false }));
    bridge.handle(event({ tStart: 0, tEnd: 0.9, text: 'a b', final: false }));

    expect(store.segments).toHaveLength(1); // no second add_segment call
    expect(store.patches).toEqual([{ id: 's1', patch: { tEnd: 0.9, text: 'a b', final: false } }]);
  });

  it('finalizes the open segment on a final event, then opens a fresh one for the next tStart', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store);

    bridge.handle(event({ tStart: 0, tEnd: 0.5, text: 'a', final: false }));
    bridge.handle(event({ tStart: 0, tEnd: 1.05, text: 'a b c', final: true }));
    bridge.handle(event({ speaker: 'R', tStart: 1.05, tEnd: 1.4, text: 'yo', final: true }));

    expect(store.segments).toHaveLength(2);
    expect(store.patches).toEqual([{ id: 's1', patch: { tEnd: 1.05, text: 'a b c', final: true } }]);
    expect(store.segments[1]).toMatchObject({ speaker: 'R', tStart: 1.05, tEnd: 1.4, text: 'yo', final: true });
    expect(store.speakers).toEqual(['L', 'L', 'R']);
  });

  it('v0.2: a simulated whisper-style sequence (same tStart, a REWRITTEN — not appended — growing text each tick, then final) grows one segment, not several', () => {
    // Mirrors server/lib/whisper_stream.mjs's sliding-window re-decode:
    // every tick re-transcribes the WHOLE current window and reports its
    // full text, so later events' `text` is not a superstring built by
    // appending to the previous one — it can shrink, grow unevenly, or
    // even change earlier words as the decoder's guess improves. The
    // bridge must not care: it keys purely on `tStart` staying identical.
    const store = fake_store();
    const bridge = create_engine_bridge(store);

    bridge.handle(event({ tStart: 2, tEnd: 3.5, text: 'hel', final: false }));
    bridge.handle(event({ tStart: 2, tEnd: 5.0, text: 'hello the', final: false }));
    bridge.handle(event({ tStart: 2, tEnd: 6.5, text: 'hello', final: false })); // whisper "changed its mind" — SHORTER, not appended
    bridge.handle(event({ tStart: 2, tEnd: 8.0, text: 'hello there friend', final: true }));

    expect(store.segments).toHaveLength(1); // exactly one add_segment call for the whole turn
    expect(store.patches.map((p) => p.patch.text)).toEqual(['hello the', 'hello', 'hello there friend']);
    expect(store.patches[store.patches.length - 1].patch.final).toBe(true);
  });

  it('a lone final event with no prior partial still opens (and immediately closes) its own segment', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store);

    bridge.handle(event({ tStart: 0, tEnd: 0.35, text: 'hi', final: true }));

    expect(store.segments).toHaveLength(1);
    expect(store.patches).toHaveLength(0);
    expect(store.segments[0]).toMatchObject({ text: 'hi', final: true });
  });
});

describe('engine_bridge: live-transcription-visibility fix — unattributed (speaker: null) events', () => {
  it('opens an unattributed segment for a null-speaker event, rather than dropping it', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store, { driveSpeaker: false });

    bridge.handle(event({ speaker: null, tStart: 0, tEnd: 2.6, text: 'said before a speaker was chosen', final: false }));

    expect(store.segments).toHaveLength(1);
    expect(store.segments[0]).toMatchObject({ speaker: null, text: 'said before a speaker was chosen', final: false });
    expect(store.speakers).toEqual([]); // driveSpeaker:false — currentSpeaker untouched, same as any mic-engine event
  });

  it('driveSpeaker:true never calls set_speaker(null) — a null speaker must not clobber currentSpeaker', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store); // driveSpeaker defaults to true

    bridge.handle(event({ speaker: null, tStart: 0, tEnd: 0.5, text: 'x', final: false }));

    expect(store.speakers).toEqual([]);
    expect(store.currentSpeaker).toBeNull();
  });

  it('late attribution: a later event for the SAME open turn (same tStart) with a real speaker promotes the segment in place via update_partial, rather than opening a duplicate', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store, { driveSpeaker: false });

    bridge.handle(event({ speaker: null, tStart: 0, tEnd: 2.6, text: 'said before a speaker was chosen', final: false }));
    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 4.3, text: 'said before a speaker was chosen and more', final: false }));

    expect(store.segments).toHaveLength(1); // no second add_segment call — the pending text became L's, not a duplicate
    expect(store.segments[0]).toMatchObject({ speaker: null }); // add_segment's own input snapshot is unchanged; the PATCH is what carries the promotion
    expect(store.patches).toEqual([
      { id: 's1', patch: { tEnd: 4.3, text: 'said before a speaker was chosen and more', final: false, speaker: 'L' } }
    ]);
  });

  it('late attribution survives all the way to final, and the next turn opens fresh (no leftover promotion)', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store, { driveSpeaker: false });

    bridge.handle(event({ speaker: null, tStart: 0, tEnd: 1.0, text: 'a', final: false }));
    bridge.handle(event({ speaker: 'R', tStart: 0, tEnd: 2.0, text: 'a b', final: true }));
    bridge.handle(event({ speaker: null, tStart: 2.0, tEnd: 2.5, text: 'c', final: false })); // a fresh, unrelated turn

    expect(store.segments).toHaveLength(2);
    expect(store.patches[0]).toEqual({ id: 's1', patch: { tEnd: 2.0, text: 'a b', final: true, speaker: 'R' } });
    expect(store.segments[1]).toMatchObject({ speaker: null, text: 'c' }); // NOT silently promoted to 'R' from the prior turn
  });

  it('once a segment is attributed, a later null-speaker event for the SAME turn does NOT un-attribute it (patch never re-adds a speaker key once set)', () => {
    // Cannot happen via mic_engine.ts's real turn tracker (label_event
    // never regresses a real speaker back to null mid-turn), but the
    // bridge's own guard (`openSpeaker === null && event.speaker !== null`)
    // is what actually prevents it structurally — worth asserting
    // directly rather than only trusting the upstream invariant.
    const store = fake_store();
    const bridge = create_engine_bridge(store, { driveSpeaker: false });

    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 1.0, text: 'a', final: false }));
    bridge.handle(event({ speaker: null, tStart: 0, tEnd: 2.0, text: 'a b', final: false }));

    expect(store.patches).toEqual([{ id: 's1', patch: { tEnd: 2.0, text: 'a b', final: false } }]); // no `speaker` key — 'L' stands
  });
});

describe('engine_bridge: driveSpeaker option (v0.2 fix round 1, Important 1)', () => {
  it('defaults to true (replay_engine.ts\'s unchanged v0.1 behavior) when the option is omitted entirely', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store); // no options arg at all

    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 0.5, text: 'a', final: false }));

    expect(store.speakers).toEqual(['L']);
    expect(store.currentSpeaker).toBe('L');
  });

  it('driveSpeaker:true (explicit) still calls set_speaker on every event, same as the default', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store, { driveSpeaker: true });

    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 0.5, text: 'a', final: false }));
    bridge.handle(event({ speaker: 'R', tStart: 0.5, tEnd: 1, text: 'b', final: true }));

    expect(store.speakers).toEqual(['L', 'R']);
  });

  it('driveSpeaker:false never calls set_speaker at all, for any event', () => {
    const store = fake_store();
    const bridge = create_engine_bridge(store, { driveSpeaker: false });

    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 0.5, text: 'a', final: false }));
    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 1.0, text: 'a b', final: true }));
    bridge.handle(event({ speaker: 'R', tStart: 1.0, tEnd: 1.4, text: 'c', final: true }));

    expect(store.speakers).toEqual([]);
    expect(store.currentSpeaker).toBeNull();
    // Segment bookkeeping (the bridge's actual job) still works normally —
    // driveSpeaker only gates the set_speaker side effect.
    expect(store.segments).toHaveLength(2);
  });

  it('the exact reviewed regression: a manual ArrowRight switch is NOT reverted by the flush-triggered final for the outgoing turn', () => {
    // Reproduces mic_engine.ts's real sequence: a manual key sets
    // currentSpeaker DIRECTLY (as app.svelte's keymap dispatch does,
    // never through the bridge) mid-utterance; the server's flush for the
    // now-outgoing 'L' window still arrives afterward, correctly labeled
    // 'L' (mic_engine_core.ts's MicTurnTracker — that label is right, the
    // bug is only what the BRIDGE used to do with it).
    const store = fake_store();
    const bridge = create_engine_bridge(store, { driveSpeaker: false });

    store.set_speaker('L'); // manual: ArrowLeft, session start
    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 0.5, text: 'a', final: false })); // L partial, in flight

    store.set_speaker('R'); // manual: ArrowRight, pressed mid-utterance
    expect(store.currentSpeaker).toBe('R');

    // The flush this manual switch triggered server-side finally resolves
    // — its final event still correctly reports the OLD speaker 'L' (who
    // was actually talking), arriving well after the manual switch above.
    bridge.handle(event({ speaker: 'L', tStart: 0, tEnd: 1.2, text: 'a b c', final: true }));

    // The critical assertion: currentSpeaker must still be 'R' — NOT
    // reverted to 'L' by the late-arriving engine event.
    expect(store.currentSpeaker).toBe('R');
    // Only the two manual set_speaker calls ever happened — the bridge
    // itself made zero.
    expect(store.speakers).toEqual(['L', 'R']);

    // And the segment itself is still correctly attributed to 'L' — this
    // fix is purely about currentSpeaker, not about corrupting the
    // transcript's own per-segment speaker field. The final event grows
    // the SAME segment opened by the first ('a') partial above (same
    // tStart), via update_partial, not a new add_segment call.
    expect(store.segments[0]).toMatchObject({ speaker: 'L', text: 'a', final: false });
    expect(store.patches).toEqual([{ id: 's1', patch: { tEnd: 1.2, text: 'a b c', final: true } }]);

    // A subsequent partial for the NEW ('R') window keeps currentSpeaker
    // untouched by the bridge too.
    bridge.handle(event({ speaker: 'R', tStart: 1.2, tEnd: 1.5, text: 'd', final: false }));
    expect(store.currentSpeaker).toBe('R');
    expect(store.speakers).toEqual(['L', 'R']); // still just the two manual calls
  });
});
