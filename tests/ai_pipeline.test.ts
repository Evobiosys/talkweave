// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  create_in_flight_guard,
  ollama_offline_next_state,
  should_extract_claim_for_flag,
  window_claim_context
} from '../app/src/lib/ai_pipeline';
import type { Flag, Segment } from '../shared/model';

function flag(overrides: Partial<Flag> = {}): Flag {
  return {
    id: 'f1',
    t: 5,
    by: 'L',
    segmentId: null,
    claimText: null,
    charStart: null,
    charEnd: null,
    source: 'key',
    ...overrides
  };
}

function seg(id: string, tStart: number, tEnd: number, text = `text ${id}`, final = true): Segment {
  return { id, speaker: tStart % 2 === 0 ? 'L' : 'R', tStart, tEnd, text, final };
}

describe('should_extract_claim_for_flag (review fix round 1, Critical 1)', () => {
  it('is true only for source:"key" flags', () => {
    expect(should_extract_claim_for_flag(flag({ source: 'key' }))).toBe(true);
  });

  it('is false for source:"dblclick" flags — they already carry an exact span', () => {
    expect(should_extract_claim_for_flag(flag({ source: 'dblclick', charStart: 3, charEnd: 9 }))).toBe(false);
  });

  it('is false for source:"ai" flags (already AI-derived, not a fresh candidate)', () => {
    expect(should_extract_claim_for_flag(flag({ source: 'ai' }))).toBe(false);
  });
});

describe('window_claim_context (review fix round 1, Important 2)', () => {
  it('returns all eligible segments when there are fewer than the window size', () => {
    const segments = [seg('s1', 0, 1), seg('s2', 1, 2), seg('s3', 2, 3)];
    const windowed = window_claim_context(segments, 10, 12);
    expect(windowed.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('caps to the last windowSize final segments nearest to flagT, in chronological order', () => {
    const segments = Array.from({ length: 20 }, (_, i) => seg(`s${i}`, i, i + 1));
    const windowed = window_claim_context(segments, 20, 12);
    expect(windowed).toHaveLength(12);
    expect(windowed.map((s) => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => `s${8 + i}`));
    // chronological, not nearest-first
    expect(windowed[0].tStart).toBeLessThan(windowed[windowed.length - 1].tStart);
  });

  it('excludes segments at/after flagT and non-final segments', () => {
    const segments = [seg('s1', 0, 1), seg('s2', 1, 2, 'partial', false), seg('s3', 5, 6)];
    const windowed = window_claim_context(segments, 5, 12);
    expect(windowed.map((s) => s.id)).toEqual(['s1']);
  });

  it('defaults to CLAIM_CONTEXT_WINDOW_SEGMENTS (12) when windowSize is omitted', () => {
    const segments = Array.from({ length: 20 }, (_, i) => seg(`s${i}`, i, i + 1));
    const windowed = window_claim_context(segments, 20);
    expect(windowed).toHaveLength(12);
  });
});

describe('ollama_offline_next_state (review fix round 1, Important 4)', () => {
  it('leaves current state untouched when ollamaAvailable is null (not contacted)', () => {
    expect(ollama_offline_next_state(false, null)).toBe(false);
    expect(ollama_offline_next_state(true, null)).toBe(true);
  });

  it('sets offline (true) when ollamaAvailable is false', () => {
    expect(ollama_offline_next_state(false, false)).toBe(true);
  });

  it('clears offline (false) when ollamaAvailable is true', () => {
    expect(ollama_offline_next_state(true, true)).toBe(false);
  });
});

describe('create_in_flight_guard (review fix round 1, Important 3)', () => {
  it('try_start succeeds when not busy, then reports busy', () => {
    const guard = create_in_flight_guard();
    expect(guard.is_busy()).toBe(false);
    expect(guard.try_start()).toBe(true);
    expect(guard.is_busy()).toBe(true);
  });

  it('try_start fails while already busy (the double-fire guard)', () => {
    const guard = create_in_flight_guard();
    expect(guard.try_start()).toBe(true);
    expect(guard.try_start()).toBe(false);
    expect(guard.try_start()).toBe(false);
  });

  it('finish() allows a subsequent try_start to succeed again', () => {
    const guard = create_in_flight_guard();
    guard.try_start();
    guard.finish();
    expect(guard.is_busy()).toBe(false);
    expect(guard.try_start()).toBe(true);
  });
});
