// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  card_is_settled,
  factcheck_card_reducer,
  init_factcheck_card,
  type FactCheckCardState
} from '../app/src/lib/factcheck_reducer';

describe('factcheck_reducer: init_factcheck_card', () => {
  it('starts quick_pending with everything else null/false', () => {
    const state = init_factcheck_card('fc1', 'Is this true?');
    expect(state).toEqual({
      id: 'fc1',
      question: 'Is this true?',
      status: 'quick_pending',
      quick: null,
      etaMs: null,
      deep: null,
      kept: false
    });
  });
});

describe('factcheck_card_reducer: the happy path (quick -> eta -> deep)', () => {
  it('quick -> deep_running -> deep_done, accumulating fields without losing earlier ones', () => {
    let state = init_factcheck_card('fc1', 'q');

    state = factcheck_card_reducer(state, { type: 'quick', result: { text: 'quick answer', model: 'q-model', ms: 120 } });
    expect(state.status).toBe('quick_pending');
    expect(state.quick).toEqual({ text: 'quick answer', model: 'q-model', ms: 120 });
    expect(state.deep).toBeNull();

    state = factcheck_card_reducer(state, { type: 'deep_eta', etaMs: 40000 });
    expect(state.status).toBe('deep_running');
    expect(state.etaMs).toBe(40000);
    expect(state.quick).not.toBeNull(); // earlier field survives

    state = factcheck_card_reducer(state, {
      type: 'deep',
      result: { text: 'deep answer', model: 'd-model', ms: 39000, contradicts: false, nuance: '' }
    });
    expect(state.status).toBe('deep_done');
    expect(state.deep).toEqual({ text: 'deep answer', model: 'd-model', ms: 39000, contradicts: false, nuance: '' });
    expect(state.etaMs).toBe(40000); // still retained after deep lands
  });
});

describe('factcheck_card_reducer: contradiction branch', () => {
  it('a deep result with contradicts:true carries its nuance through', () => {
    let state = init_factcheck_card('fc1', 'q');
    state = factcheck_card_reducer(state, { type: 'quick', result: { text: 'a', model: 'q', ms: 1 } });
    state = factcheck_card_reducer(state, { type: 'deep_eta', etaMs: 40000 });
    state = factcheck_card_reducer(state, {
      type: 'deep',
      result: { text: 'b', model: 'd', ms: 2, contradicts: true, nuance: 'the dates differ by a century.' }
    });
    expect(state.status).toBe('deep_done');
    expect(state.deep?.contradicts).toBe(true);
    expect(state.deep?.nuance).toBe('the dates differ by a century.');
  });
});

describe('factcheck_card_reducer: dismiss', () => {
  it('dismiss mid-deep (before the deep event arrives) transitions to dismissed', () => {
    let state = init_factcheck_card('fc1', 'q');
    state = factcheck_card_reducer(state, { type: 'quick', result: { text: 'a', model: 'q', ms: 1 } });
    state = factcheck_card_reducer(state, { type: 'deep_eta', etaMs: 40000 });
    state = factcheck_card_reducer(state, { type: 'dismiss' });
    expect(state.status).toBe('dismissed');
  });

  it('dismiss is terminal: a later quick/deep/keep action is a no-op once dismissed', () => {
    let state = init_factcheck_card('fc1', 'q');
    state = factcheck_card_reducer(state, { type: 'dismiss' });
    const dismissed = state;

    state = factcheck_card_reducer(state, { type: 'quick', result: { text: 'late', model: 'q', ms: 1 } });
    expect(state).toEqual(dismissed);

    state = factcheck_card_reducer(state, {
      type: 'deep',
      result: { text: 'late', model: 'd', ms: 1, contradicts: true, nuance: 'x' }
    });
    expect(state).toEqual(dismissed);

    state = factcheck_card_reducer(state, { type: 'keep' });
    expect(state.kept).toBe(false); // keep never un-dismisses or takes effect after dismissal
  });

  it('dismiss after deep already completed overwrites status to dismissed', () => {
    let state = init_factcheck_card('fc1', 'q');
    state = factcheck_card_reducer(state, {
      type: 'deep',
      result: { text: 'a', model: 'd', ms: 1, contradicts: false, nuance: '' }
    });
    expect(state.status).toBe('deep_done');
    state = factcheck_card_reducer(state, { type: 'dismiss' });
    expect(state.status).toBe('dismissed');
  });
});

describe('factcheck_card_reducer: keep', () => {
  it('keep sets kept:true without changing status, at any point in the lifecycle', () => {
    let state = init_factcheck_card('fc1', 'q');
    state = factcheck_card_reducer(state, { type: 'keep' });
    expect(state.kept).toBe(true);
    expect(state.status).toBe('quick_pending'); // unaffected

    state = factcheck_card_reducer(state, { type: 'quick', result: { text: 'a', model: 'q', ms: 1 } });
    expect(state.kept).toBe(true); // keep survives later events
  });

  it('keeping mid-deep-run lets the deep result still land afterward', () => {
    let state = init_factcheck_card('fc1', 'q');
    state = factcheck_card_reducer(state, { type: 'deep_eta', etaMs: 1000 });
    state = factcheck_card_reducer(state, { type: 'keep' });
    state = factcheck_card_reducer(state, {
      type: 'deep',
      result: { text: 'late but real', model: 'd', ms: 999, contradicts: false, nuance: '' }
    });
    expect(state.kept).toBe(true);
    expect(state.status).toBe('deep_done');
    expect(state.deep?.text).toBe('late but real');
  });
});

describe('card_is_settled', () => {
  it('false for a fresh or in-progress card', () => {
    const fresh = init_factcheck_card('fc1', 'q');
    expect(card_is_settled(fresh)).toBe(false);

    const running = factcheck_card_reducer(fresh, { type: 'deep_eta', etaMs: 1000 });
    expect(card_is_settled(running)).toBe(false);
  });

  it('true once dismissed', () => {
    const dismissed = factcheck_card_reducer(init_factcheck_card('fc1', 'q'), { type: 'dismiss' });
    expect(card_is_settled(dismissed)).toBe(true);
  });

  it('true once kept, even if the deep answer is still pending', () => {
    const kept = factcheck_card_reducer(init_factcheck_card('fc1', 'q'), { type: 'keep' });
    expect(card_is_settled(kept)).toBe(true);
  });

  it('a deep_done card that was neither dismissed nor kept is NOT settled', () => {
    const state: FactCheckCardState = factcheck_card_reducer(init_factcheck_card('fc1', 'q'), {
      type: 'deep',
      result: { text: 'a', model: 'd', ms: 1, contradicts: false, nuance: '' }
    });
    expect(state.status).toBe('deep_done');
    expect(card_is_settled(state)).toBe(false);
  });
});
