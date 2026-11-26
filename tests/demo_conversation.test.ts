// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { DEMO_CONVERSATION, type DemoTurn } from '../app/src/lib/fixtures/demo_conversation';

interface TimedTurn extends DemoTurn {
  tStart: number;
  tEnd: number;
}

/** Same running-sum composition replay_engine.ts uses internally — see
 *  demo_conversation.ts's header comment for why the fixture itself only
 *  stores `duration`. */
function timeline(turns: DemoTurn[]): TimedTurn[] {
  let cursor = 0;
  return turns.map((turn) => {
    const tStart = cursor;
    const tEnd = tStart + turn.duration;
    cursor = tEnd;
    return { ...turn, tStart, tEnd };
  });
}

describe('demo_conversation: fixture integrity', () => {
  it('has at least 30 turns', () => {
    expect(DEMO_CONVERSATION.length).toBeGreaterThanOrEqual(30);
  });

  it('includes both speakers', () => {
    const speakers = new Set(DEMO_CONVERSATION.map((t) => t.speaker));
    expect(speakers.has('L')).toBe(true);
    expect(speakers.has('R')).toBe(true);
  });

  it('alternates speaker on every turn', () => {
    for (let i = 1; i < DEMO_CONVERSATION.length; i++) {
      expect(DEMO_CONVERSATION[i].speaker).not.toBe(DEMO_CONVERSATION[i - 1].speaker);
    }
  });

  it('every turn has a positive duration and non-empty text', () => {
    for (const turn of DEMO_CONVERSATION) {
      expect(turn.duration).toBeGreaterThan(0);
      expect(turn.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('never uses an em dash in the copy', () => {
    for (const turn of DEMO_CONVERSATION) {
      expect(turn.text).not.toContain('—');
    }
  });

  it('produces a monotonic, non-overlapping timeline when composed', () => {
    const timed = timeline(DEMO_CONVERSATION);
    for (let i = 0; i < timed.length; i++) {
      expect(timed[i].tEnd).toBeGreaterThan(timed[i].tStart);
      if (i > 0) {
        // No gap and no overlap: this turn starts exactly where the
        // previous one ended (replay_engine.ts's composition contract).
        expect(timed[i].tStart).toBe(timed[i - 1].tEnd);
      }
    }
  });

  it('contains the documented checkable numeric claims (true and deliberately false)', () => {
    const allText = DEMO_CONVERSATION.map((t) => t.text).join(' ');
    // True claims, for contrast.
    expect(allText).toContain('1.24 million');
    expect(allText).toContain('two hundred ninety thousand');
    // Deliberately wrong claims (see fixture header comment).
    expect(allText).toContain('2005');
    expect(allText).toContain('twelve million');
  });
});
