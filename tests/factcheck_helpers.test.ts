// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { attribution_for, expanded_card_ids } from '../app/src/lib/factcheck_helpers';
import { factcheck_card_reducer, init_factcheck_card, type FactCheckCardState } from '../app/src/lib/factcheck_reducer';
import type { Flag } from '../shared/model';

function flag(overrides: Partial<Flag> = {}): Flag {
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

function running(id: string): FactCheckCardState {
  return init_factcheck_card(id, `question ${id}`);
}

function dismissed(id: string): FactCheckCardState {
  return factcheck_card_reducer(init_factcheck_card(id, `question ${id}`), { type: 'dismiss' });
}

describe('expanded_card_ids', () => {
  it('all cards are expanded when there are 2 or fewer', () => {
    const cards = [running('a'), running('b')];
    expect(expanded_card_ids(cards)).toEqual(new Set(['a', 'b']));
  });

  it('only the 2 most recently created (last in array order) stay expanded', () => {
    const cards = [running('a'), running('b'), running('c')];
    expect(expanded_card_ids(cards)).toEqual(new Set(['b', 'c']));
  });

  it('a dismissed card is always collapsed, even if it is the most recent', () => {
    const cards = [running('a'), running('b'), dismissed('c')];
    expect(expanded_card_ids(cards)).toEqual(new Set(['a', 'b']));
  });

  it('a dismissed card does not occupy one of the 2 expanded slots, letting an older card take it', () => {
    const cards = [running('a'), dismissed('b'), running('c')];
    expect(expanded_card_ids(cards)).toEqual(new Set(['a', 'c']));
  });

  it('respects a custom max', () => {
    const cards = [running('a'), running('b'), running('c'), running('d')];
    expect(expanded_card_ids(cards, 1)).toEqual(new Set(['d']));
    expect(expanded_card_ids(cards, 3)).toEqual(new Set(['b', 'c', 'd']));
  });

  it('empty list yields an empty set', () => {
    expect(expanded_card_ids([])).toEqual(new Set());
  });
});

describe('attribution_for', () => {
  it('a highlight that resolves to a real speaker wins outright, even over a flag from the other side', () => {
    expect(
      attribution_for({
        hasSelection: true,
        selectionSpeaker: 'R',
        latestFlag: flag({ by: 'L' }),
        currentSpeaker: 'L'
      })
    ).toBe('R');
  });

  it('a highlight resolving to NO speaker (spans no single segment, or that segment is unattributed) falls to listener_for(currentSpeaker), NOT to the latest flag', () => {
    expect(
      attribution_for({
        hasSelection: true,
        selectionSpeaker: null,
        latestFlag: flag({ by: 'L' }), // must be ignored — attributing here would be the same bug, just narrowed
        currentSpeaker: 'L'
      })
    ).toBe('R'); // listener_for('L') === 'R'
  });

  it('the null-speaker fallback still applies with no flag at all', () => {
    expect(
      attribution_for({ hasSelection: true, selectionSpeaker: null, latestFlag: null, currentSpeaker: 'R' })
    ).toBe('L'); // listener_for('R') === 'L'
  });

  it('with no selection at all, falls back to the latest flag\'s own side (pre-existing F behavior, unchanged)', () => {
    expect(
      attribution_for({ hasSelection: false, selectionSpeaker: null, latestFlag: flag({ by: 'R' }), currentSpeaker: 'L' })
    ).toBe('R');
  });

  it('with no selection and no flag, falls back to listener_for(currentSpeaker)', () => {
    expect(
      attribution_for({ hasSelection: false, selectionSpeaker: null, latestFlag: null, currentSpeaker: null })
    ).toBe('R'); // listener_for(null) === 'R'
  });
});
