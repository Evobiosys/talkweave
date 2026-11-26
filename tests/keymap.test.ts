// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  decide_key,
  is_typing_target,
  latest_final_segment,
  listener_for,
  opposite,
  ShiftPressTracker
} from '../app/src/lib/keymap';
import type { Segment } from '../shared/model';

function seg(overrides: Partial<Segment>): Segment {
  return {
    id: 's1',
    speaker: 'L',
    tStart: 0,
    tEnd: 1,
    text: 'hello',
    final: true,
    ...overrides
  };
}

describe('keymap: opposite / listener_for', () => {
  it('opposite maps L<->R', () => {
    expect(opposite('L')).toBe('R');
    expect(opposite('R')).toBe('L');
  });

  it('listener_for returns the opposite of a set currentSpeaker', () => {
    expect(listener_for('L')).toBe('R');
    expect(listener_for('R')).toBe('L');
  });

  it('listener_for falls back to R when currentSpeaker is null', () => {
    expect(listener_for(null)).toBe('R');
  });
});

describe('keymap: latest_final_segment', () => {
  it('returns undefined for an empty segment list', () => {
    expect(latest_final_segment([], 'L')).toBeUndefined();
  });

  it('ignores non-final segments', () => {
    const segments = [seg({ id: 's1', speaker: 'L', final: false })];
    expect(latest_final_segment(segments, 'L')).toBeUndefined();
  });

  it('returns the most recently added (last in array order) matching final segment', () => {
    const segments = [
      seg({ id: 's1', speaker: 'L', final: true }),
      seg({ id: 's2', speaker: 'R', final: true }),
      seg({ id: 's3', speaker: 'L', final: true }),
      seg({ id: 's4', speaker: 'L', final: false })
    ];
    expect(latest_final_segment(segments, 'L')?.id).toBe('s3');
    expect(latest_final_segment(segments, 'R')?.id).toBe('s2');
  });

  it('matches null speaker against unattributed segments', () => {
    const segments = [seg({ id: 's1', speaker: null, final: true }), seg({ id: 's2', speaker: 'L', final: true })];
    expect(latest_final_segment(segments, null)?.id).toBe('s1');
  });
});

describe('keymap: decide_key — ArrowLeft/ArrowRight', () => {
  it('ArrowLeft sets currentSpeaker to L', () => {
    const action = decide_key({ code: 'ArrowLeft', segments: [], currentSpeaker: null, now: 5, isTypingTarget: false });
    expect(action).toEqual({ type: 'set_speaker', speaker: 'L' });
  });

  it('ArrowRight sets currentSpeaker to R', () => {
    const action = decide_key({ code: 'ArrowRight', segments: [], currentSpeaker: 'L', now: 5, isTypingTarget: false });
    expect(action).toEqual({ type: 'set_speaker', speaker: 'R' });
  });
});

describe('keymap: decide_key — ShiftLeft/ShiftRight', () => {
  const segments = [seg({ id: 's1', speaker: 'R', final: true, text: 'the point R made' })];

  it('ShiftLeft creates a flag by L targeting the latest final R segment', () => {
    const action = decide_key({ code: 'ShiftLeft', segments, currentSpeaker: null, now: 12.5, isTypingTarget: false });
    expect(action).toEqual({
      type: 'create_flag',
      flag: {
        by: 'L',
        segmentId: 's1',
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: 12.5
      }
    });
  });

  it('ShiftRight creates a flag by R targeting the latest final L segment', () => {
    const lSegments = [seg({ id: 's9', speaker: 'L', final: true })];
    const action = decide_key({ code: 'ShiftRight', segments: lSegments, currentSpeaker: null, now: 3, isTypingTarget: false });
    expect(action).toEqual({
      type: 'create_flag',
      flag: {
        by: 'R',
        segmentId: 's9',
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: 3
      }
    });
  });

  it('no-eligible-segment case: ShiftLeft with no final R segment creates an unanchored flag at now', () => {
    const noMatch = [seg({ id: 's1', speaker: 'L', final: true })];
    const action = decide_key({ code: 'ShiftLeft', segments: noMatch, currentSpeaker: null, now: 42, isTypingTarget: false });
    expect(action).toEqual({
      type: 'create_flag',
      flag: {
        by: 'L',
        segmentId: null,
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: 42
      }
    });
  });
});

describe('keymap: decide_key — Space', () => {
  it('Space creates a flag by the listener, targeting the latest final segment of currentSpeaker', () => {
    const segments = [
      seg({ id: 's1', speaker: 'R', final: true }),
      seg({ id: 's2', speaker: 'R', final: true })
    ];
    const action = decide_key({ code: 'Space', segments, currentSpeaker: 'R', now: 7, isTypingTarget: false });
    expect(action).toEqual({
      type: 'create_flag',
      flag: {
        by: 'L',
        segmentId: 's2',
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: 7
      }
    });
  });

  it('Space with currentSpeaker null targets the latest final unattributed segment, by falls back to R', () => {
    const segments = [seg({ id: 's1', speaker: null, final: true })];
    const action = decide_key({ code: 'Space', segments, currentSpeaker: null, now: 1, isTypingTarget: false });
    expect(action).toEqual({
      type: 'create_flag',
      flag: {
        by: 'R',
        segmentId: 's1',
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: 1
      }
    });
  });

  it('no-eligible-segment case: Space with no matching segment creates an unanchored flag', () => {
    const action = decide_key({ code: 'Space', segments: [], currentSpeaker: 'L', now: 99, isTypingTarget: false });
    expect(action).toEqual({
      type: 'create_flag',
      flag: {
        by: 'R',
        segmentId: null,
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: 99
      }
    });
  });
});

describe('keymap: decide_key — input-focus suppression', () => {
  it('returns null for every mapped key when isTypingTarget is true', () => {
    const base = { segments: [], currentSpeaker: null as const, now: 1, isTypingTarget: true };
    expect(decide_key({ ...base, code: 'ArrowLeft' })).toBeNull();
    expect(decide_key({ ...base, code: 'ArrowRight' })).toBeNull();
    expect(decide_key({ ...base, code: 'ShiftLeft' })).toBeNull();
    expect(decide_key({ ...base, code: 'ShiftRight' })).toBeNull();
    expect(decide_key({ ...base, code: 'Space' })).toBeNull();
  });

  it('unmapped keys return null regardless of typing focus', () => {
    expect(
      decide_key({ code: 'KeyA', segments: [], currentSpeaker: null, now: 1, isTypingTarget: false })
    ).toBeNull();
  });
});

describe('keymap: is_typing_target', () => {
  it('true for INPUT/TEXTAREA tagName and isContentEditable', () => {
    expect(is_typing_target({ tagName: 'INPUT' })).toBe(true);
    expect(is_typing_target({ tagName: 'TEXTAREA' })).toBe(true);
    expect(is_typing_target({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('false for a plain element, null, undefined, and non-objects', () => {
    expect(is_typing_target({ tagName: 'DIV' })).toBe(false);
    expect(is_typing_target(null)).toBe(false);
    expect(is_typing_target(undefined)).toBe(false);
    expect(is_typing_target('DIV')).toBe(false);
  });
});

describe('keymap: ShiftPressTracker', () => {
  it('fires on keyup after a plain press (no intervening keydown)', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft');
    expect(t.on_keyup('ShiftLeft')).toBe('ShiftLeft');
  });

  it('does not fire when another key goes down while Shift is held (combo)', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft');
    t.on_keydown('KeyA');
    expect(t.on_keyup('ShiftLeft')).toBeNull();
  });

  it('a Shift+Arrow/Shift+Space combo also suppresses the flag', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftRight');
    t.on_keydown('Space');
    expect(t.on_keyup('ShiftRight')).toBeNull();
  });

  it('resets after firing, so the next plain press fires again', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft');
    expect(t.on_keyup('ShiftLeft')).toBe('ShiftLeft');
    t.on_keydown('ShiftLeft');
    expect(t.on_keyup('ShiftLeft')).toBe('ShiftLeft');
  });

  it('ignores a keyup for a code that is not the currently-tracked shift key', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft');
    expect(t.on_keyup('ShiftRight')).toBeNull();
  });

  // Fix round 1 (review finding, Important): a modifier (Cmd/Ctrl/Alt)
  // already held *before* Shift goes down never produces a keydown that
  // lands between Shift's own keydown and keyup, so ordering-based combo
  // detection alone misses it — on_keydown/on_keyup now also take
  // `hasOtherModifier` (event.metaKey || event.ctrlKey || event.altKey).
  it('modifier-held-then-shift-tap: does not fire (hasOtherModifier on keydown)', () => {
    const t = new ShiftPressTracker();
    // Meta was already down when Shift went down — its own keydown never
    // reached this tracker (that's the whole point of the gap).
    t.on_keydown('ShiftLeft', /* hasOtherModifier */ true);
    expect(t.on_keyup('ShiftLeft')).toBeNull();
  });

  it('modifier-held-through-release: does not fire even if hasOtherModifier was missed on keydown (defense in depth via keyup)', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft'); // simulates the keydown call site somehow missing the modifier
    expect(t.on_keyup('ShiftLeft', /* hasOtherModifier */ true)).toBeNull();
  });

  it('shift-then-other-key: still does not fire (already covered, re-asserted alongside the modifier cases)', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft');
    t.on_keydown('KeyA');
    expect(t.on_keyup('ShiftLeft')).toBeNull();
  });

  it('plain shift tap with no modifier held: fires', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft', false);
    expect(t.on_keyup('ShiftLeft', false)).toBe('ShiftLeft');
  });

  // Fix round 1 (review finding, Minor): both shift keys held
  // simultaneously previously overwrote tracking to the second key,
  // letting its own release still fire a "plain press" flag.
  it('both-shifts-held-simultaneously: suppresses the in-progress press instead of switching tracking', () => {
    const t = new ShiftPressTracker();
    t.on_keydown('ShiftLeft');
    t.on_keydown('ShiftRight'); // held while ShiftLeft is still down
    expect(t.on_keyup('ShiftLeft')).toBeNull();
    // ShiftRight was never actually tracked as its own press (downCode
    // stayed 'ShiftLeft' until the keyup above cleared it), so its keyup
    // is a no-op too — no flag fires for either key.
    expect(t.on_keyup('ShiftRight')).toBeNull();
  });
});
