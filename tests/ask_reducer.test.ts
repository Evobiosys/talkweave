// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { ask_card_reducer, init_ask_card, type AskMatch } from '../app/src/lib/ask_reducer';

function match(overrides: Partial<AskMatch> = {}): AskMatch {
  return { segmentId: 's1', speaker: 'L', tStart: 0, text: 'hello', score: 0.9, ...overrides };
}

describe('init_ask_card', () => {
  it('starts idle with the given matches already present (retrieval already ran)', () => {
    const matches = [match()];
    const state = init_ask_card('a1', 'recall', 'the passage', matches);
    expect(state).toEqual({
      id: 'a1',
      mode: 'recall',
      query: 'the passage',
      matches,
      modelStatus: 'idle',
      modelText: null,
      sameTopic: null,
      contradicts: null
    });
  });

  it('an empty matches array is a legitimate result, not a placeholder', () => {
    expect(init_ask_card('a1', 'recall', 'q', []).matches).toEqual([]);
  });
});

describe('ask_card_reducer', () => {
  it('model_running moves to running without touching matches', () => {
    const state = init_ask_card('a1', 'recall', 'q', [match()]);
    const next = ask_card_reducer(state, { type: 'model_running' });
    expect(next.modelStatus).toBe('running');
    expect(next.matches).toBe(state.matches);
  });

  it('model_result (recall) sets modelText + sameTopic, leaves contradicts null', () => {
    const state = init_ask_card('a1', 'recall', 'q', []);
    const next = ask_card_reducer(state, { type: 'model_result', text: 'same thing.', sameTopic: true });
    expect(next.modelStatus).toBe('done');
    expect(next.modelText).toBe('same thing.');
    expect(next.sameTopic).toBe(true);
    expect(next.contradicts).toBeNull();
  });

  it('model_result (contradiction) sets modelText + contradicts, leaves sameTopic null', () => {
    const state = init_ask_card('a1', 'contradiction', 'q', []);
    const next = ask_card_reducer(state, { type: 'model_result', text: 'they disagree.', contradicts: true });
    expect(next.contradicts).toBe(true);
    expect(next.sameTopic).toBeNull();
  });

  it('model_result (freeform) sets modelText with neither flag', () => {
    const state = init_ask_card('a1', 'freeform', 'q', []);
    const next = ask_card_reducer(state, { type: 'model_result', text: 'the answer.' });
    expect(next.modelText).toBe('the answer.');
    expect(next.sameTopic).toBeNull();
    expect(next.contradicts).toBeNull();
  });

  it('model_unavailable sets status without touching matches or modelText', () => {
    const state = init_ask_card('a1', 'recall', 'q', [match()]);
    const next = ask_card_reducer(state, { type: 'model_unavailable' });
    expect(next.modelStatus).toBe('unavailable');
    expect(next.modelText).toBeNull();
    expect(next.matches).toEqual([match()]);
  });

  it('dismiss is terminal — every later action is a no-op', () => {
    const dismissed = ask_card_reducer(init_ask_card('a1', 'recall', 'q', []), { type: 'dismiss' });
    expect(dismissed.modelStatus).toBe('dismissed');
    const afterLateResult = ask_card_reducer(dismissed, { type: 'model_result', text: 'too late', sameTopic: true });
    expect(afterLateResult).toBe(dismissed);
  });
});
