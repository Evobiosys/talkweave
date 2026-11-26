// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { excerpt_for, latest_flag, tier_for_index, truncate } from '../app/src/lib/flag_helpers';
import type { Flag, Segment } from '../shared/model';

function flag(overrides: Partial<Flag>): Flag {
  return {
    id: 'f1',
    t: 0,
    by: 'L',
    segmentId: null,
    claimText: null,
    charStart: null,
    charEnd: null,
    source: 'key',
    ...overrides
  };
}

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

describe('flag_helpers: truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('short', 120)).toBe('short');
  });

  it('returns text exactly at the limit unchanged (no ellipsis)', () => {
    const text = 'x'.repeat(120);
    expect(truncate(text, 120)).toBe(text);
    expect(truncate(text, 120).length).toBe(120);
  });

  it('truncates and adds an ellipsis, never exceeding max length', () => {
    const text = 'x'.repeat(150);
    const result = truncate(text, 120);
    expect(result.length).toBe(120);
    expect(result.endsWith('…')).toBe(true);
  });

  it('trims trailing whitespace before the ellipsis', () => {
    const text = `${'a'.repeat(118)}   more text here`;
    const result = truncate(text, 120);
    expect(result).not.toMatch(/\s…$/);
  });
});

describe('flag_helpers: excerpt_for', () => {
  const segments = [seg({ id: 's1', text: 'The point they made about the budget.' })];

  it('prefers claimText when set', () => {
    const f = flag({ segmentId: 's1', claimText: 'the budget claim' });
    expect(excerpt_for(f, segments)).toBe('the budget claim');
  });

  it('falls back to the segment text excerpt when claimText is null', () => {
    const f = flag({ segmentId: 's1', claimText: null });
    expect(excerpt_for(f, segments)).toBe('The point they made about the budget.');
  });

  it('falls back to the segment text when claimText is empty/whitespace-only', () => {
    const f = flag({ segmentId: 's1', claimText: '   ' });
    expect(excerpt_for(f, segments)).toBe('The point they made about the budget.');
  });

  it('shows "moment" for an unanchored flag with no claimText and no segment', () => {
    const f = flag({ segmentId: null, claimText: null });
    expect(excerpt_for(f, segments)).toBe('moment');
  });

  it('shows "moment" when segmentId points at a segment that no longer exists', () => {
    const f = flag({ segmentId: 'does-not-exist', claimText: null });
    expect(excerpt_for(f, segments)).toBe('moment');
  });

  it('truncates a long claim/excerpt to ~120 chars', () => {
    const longClaim = 'word '.repeat(40).trim();
    const f = flag({ segmentId: 's1', claimText: longClaim });
    const result = excerpt_for(f, segments);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('flag_helpers: tier_for_index', () => {
  it('the 3 most recent (index 0-2) are tier 0', () => {
    expect(tier_for_index(0)).toBe(0);
    expect(tier_for_index(1)).toBe(0);
    expect(tier_for_index(2)).toBe(0);
  });

  it('steps down one tier per position after the top 3', () => {
    expect(tier_for_index(3)).toBe(1);
    expect(tier_for_index(4)).toBe(2);
    expect(tier_for_index(5)).toBe(3);
    expect(tier_for_index(6)).toBe(4);
  });

  it('caps at tier 4 for a long history', () => {
    expect(tier_for_index(20)).toBe(4);
    expect(tier_for_index(1000)).toBe(4);
  });
});

describe('flag_helpers: latest_flag (Task 10 fact-check prefill)', () => {
  it('returns null for an empty list', () => {
    expect(latest_flag([])).toBeNull();
  });

  it('returns the single flag when there is only one', () => {
    const f = flag({ id: 'f1', t: 5 });
    expect(latest_flag([f])).toBe(f);
  });

  it('returns the flag with the largest t regardless of array order', () => {
    const early = flag({ id: 'f1', t: 1 });
    const latest = flag({ id: 'f2', t: 9 });
    const middle = flag({ id: 'f3', t: 5 });
    expect(latest_flag([early, latest, middle])).toBe(latest);
    expect(latest_flag([latest, middle, early])).toBe(latest);
  });
});
