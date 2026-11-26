// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import type { Session } from '../shared/model';
import * as core from '../app/src/lib/session_store_core';
import type { StoreState } from '../app/src/lib/session_store_core';

function empty_session(id = 's-1'): Session {
  return {
    id,
    startedAt: '2026-08-18T00:00:00.000Z',
    title: 'Test session',
    names: { L: 'Alice', R: 'Bob' },
    segments: [],
    flags: [],
    notes: [],
    pauses: [],
    summaries: [],
    factChecks: [],
    audioFile: null
  };
}

function fresh_state(): StoreState {
  return { session: empty_session(), dirty: 0, currentSpeaker: null };
}

describe('session_store_core: add_segment', () => {
  it('assigns increasing ids and bumps dirty', () => {
    const state = fresh_state();
    const id1 = core.add_segment(state, { speaker: 'L', tStart: 0, tEnd: 1, text: 'hi', final: true });
    const id2 = core.add_segment(state, { speaker: 'R', tStart: 1, tEnd: 2, text: 'yo', final: true });
    expect(id1).toBe('s1');
    expect(id2).toBe('s2');
    expect(state.session.segments.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(state.dirty).toBe(2);
  });
});

describe('session_store_core: update_partial', () => {
  it('patches the matching segment and bumps dirty', () => {
    const state = fresh_state();
    const id = core.add_segment(state, { speaker: 'L', tStart: 0, tEnd: 1, text: 'partial', final: false });
    const dirtyBefore = state.dirty;
    const changed = core.update_partial(state, id, { text: 'partial done', tEnd: 2, final: true });
    expect(changed).toBe(true);
    expect(state.session.segments[0]).toMatchObject({ text: 'partial done', tEnd: 2, final: true });
    expect(state.dirty).toBe(dirtyBefore + 1);
  });

  it('is a no-op and does not bump dirty for an unknown id', () => {
    const state = fresh_state();
    const dirtyBefore = state.dirty;
    const changed = core.update_partial(state, 'does-not-exist', { text: 'x' });
    expect(changed).toBe(false);
    expect(state.dirty).toBe(dirtyBefore);
  });
});

describe('session_store_core: add_flag', () => {
  it('assigns increasing ids independent of the segment id prefix and bumps dirty', () => {
    const state = fresh_state();
    const segId = core.add_segment(state, { speaker: 'L', tStart: 0, tEnd: 1, text: 'x', final: true });
    const id1 = core.add_flag(state, {
      t: 0.5,
      by: 'L',
      segmentId: segId,
      claimText: null,
      charStart: null,
      charEnd: null,
      source: 'key'
    });
    const id2 = core.add_flag(state, {
      t: 0.9,
      by: 'R',
      segmentId: segId,
      claimText: 'claim',
      charStart: 0,
      charEnd: 4,
      source: 'dblclick'
    });
    expect(id1).toBe('f1');
    expect(id2).toBe('f2');
    expect(state.session.flags).toHaveLength(2);
    expect(state.dirty).toBe(3); // 1 segment + 2 flags
  });
});

describe('session_store_core: add_note', () => {
  it('assigns ids with the n prefix and bumps dirty', () => {
    const state = fresh_state();
    const id = core.add_note(state, { t: 1, by: 'L', text: 'note text' });
    expect(id).toBe('n1');
    expect(state.session.notes).toEqual([{ id: 'n1', t: 1, by: 'L', text: 'note text' }]);
    expect(state.dirty).toBe(1);
  });
});

describe('session_store_core: set_title', () => {
  it('sets session.title and bumps dirty', () => {
    const state = fresh_state();
    core.set_title(state, 'Renewed lease negotiation');
    expect(state.session.title).toBe('Renewed lease negotiation');
    expect(state.dirty).toBe(1);
  });
});

describe('session_store_core: set_names', () => {
  it('patches only the given side, leaving the other untouched', () => {
    const state = fresh_state();
    core.set_names(state, { L: 'Alicia' });
    expect(state.session.names).toEqual({ L: 'Alicia', R: 'Bob' });
    expect(state.dirty).toBe(1);

    core.set_names(state, { R: 'Robert' });
    expect(state.session.names).toEqual({ L: 'Alicia', R: 'Robert' });
    expect(state.dirty).toBe(2);
  });

  it('patches both sides at once', () => {
    const state = fresh_state();
    core.set_names(state, { L: 'A', R: 'B' });
    expect(state.session.names).toEqual({ L: 'A', R: 'B' });
    expect(state.dirty).toBe(1);
  });
});

describe('session_store_core: set_speaker', () => {
  it('sets currentSpeaker and bumps dirty (per the brief: every mutation bumps dirty)', () => {
    const state = fresh_state();
    core.set_speaker(state, 'R');
    expect(state.currentSpeaker).toBe('R');
    expect(state.dirty).toBe(1);

    core.set_speaker(state, null);
    expect(state.currentSpeaker).toBeNull();
    expect(state.dirty).toBe(2);
  });

  it('does not touch session at all (currentSpeaker is not persisted)', () => {
    const state = fresh_state();
    const before = JSON.stringify(state.session);
    core.set_speaker(state, 'L');
    expect(JSON.stringify(state.session)).toBe(before);
  });
});

describe('session_store_core: add_summary', () => {
  it('assigns ids with the sm prefix and bumps dirty', () => {
    const state = fresh_state();
    const id = core.add_summary(state, { tFrom: 0, tTo: 60, text: 'summary', trigger: 'interval' });
    expect(id).toBe('sm1');
    expect(state.session.summaries[0]).toMatchObject({ id: 'sm1', trigger: 'interval' });
    expect(state.dirty).toBe(1);
  });
});

describe('session_store_core: fact-check mutations', () => {
  it('add_fact_check starts with null quick/deep and bumps dirty', () => {
    const state = fresh_state();
    const id = core.add_fact_check(state, { t: 1, by: 'L', question: 'is this true?' });
    expect(id).toBe('fc1');
    expect(state.session.factChecks[0]).toEqual({
      id: 'fc1',
      t: 1,
      by: 'L',
      question: 'is this true?',
      quick: null,
      deep: null
    });
    expect(state.dirty).toBe(1);
  });

  it('set_fact_check_quick updates the matching fact-check and bumps dirty', () => {
    const state = fresh_state();
    const id = core.add_fact_check(state, { t: 1, by: 'L', question: 'q' });
    const dirtyBefore = state.dirty;
    const changed = core.set_fact_check_quick(state, id, { text: 'quick answer', model: 'qwen3:4b', ms: 120 });
    expect(changed).toBe(true);
    expect(state.session.factChecks[0].quick).toEqual({ text: 'quick answer', model: 'qwen3:4b', ms: 120 });
    expect(state.dirty).toBe(dirtyBefore + 1);
  });

  it('set_fact_check_deep updates the matching fact-check and bumps dirty', () => {
    const state = fresh_state();
    const id = core.add_fact_check(state, { t: 1, by: 'L', question: 'q' });
    const dirtyBefore = state.dirty;
    const changed = core.set_fact_check_deep(state, id, {
      status: 'done',
      text: 'deep answer',
      model: 'big-model',
      etaMs: null,
      contradicts: true
    });
    expect(changed).toBe(true);
    expect(state.session.factChecks[0].deep).toEqual({
      status: 'done',
      text: 'deep answer',
      model: 'big-model',
      etaMs: null,
      contradicts: true
    });
    expect(state.dirty).toBe(dirtyBefore + 1);
  });

  it('set_fact_check_quick/deep are no-ops (no dirty bump) for an unknown id', () => {
    const state = fresh_state();
    const dirtyBefore = state.dirty;
    expect(core.set_fact_check_quick(state, 'nope', { text: 'x', model: 'm', ms: 1 })).toBe(false);
    expect(
      core.set_fact_check_deep(state, 'nope', { status: 'running', text: null, model: 'm', etaMs: null, contradicts: false })
    ).toBe(false);
    expect(state.dirty).toBe(dirtyBefore);
  });
});

describe('session_store_core: update_flag_claim', () => {
  it('replaces segmentId/claimText/charStart/charEnd wholesale and sets source when given', () => {
    const state = fresh_state();
    const segId = core.add_segment(state, { speaker: 'L', tStart: 0, tEnd: 1, text: 'whole segment text', final: true });
    const flagId = core.add_flag(state, {
      t: 0.5,
      by: 'R',
      segmentId: segId,
      claimText: null,
      charStart: null,
      charEnd: null,
      source: 'key'
    });
    const dirtyBefore = state.dirty;

    const changed = core.update_flag_claim(state, flagId, {
      segmentId: segId,
      claimText: 'whole segment',
      charStart: 0,
      charEnd: 13,
      source: 'ai'
    });

    expect(changed).toBe(true);
    const flag = state.session.flags[0];
    expect(flag).toMatchObject({ claimText: 'whole segment', charStart: 0, charEnd: 13, source: 'ai' });
    expect(state.dirty).toBe(dirtyBefore + 1);
  });

  it('leaves source unchanged (a fallback result) when source is omitted from the patch', () => {
    const state = fresh_state();
    const segId = core.add_segment(state, { speaker: 'L', tStart: 0, tEnd: 1, text: 'text here', final: true });
    const flagId = core.add_flag(state, {
      t: 0.5,
      by: 'R',
      segmentId: segId,
      claimText: null,
      charStart: null,
      charEnd: null,
      source: 'dblclick'
    });

    core.update_flag_claim(state, flagId, { segmentId: segId, claimText: 'text', charStart: 0, charEnd: 4 });

    const flag = state.session.flags[0];
    expect(flag.source).toBe('dblclick'); // untouched — no 'ai' glyph for a fallback update
    expect(flag.claimText).toBe('text');
  });

  it('can update segmentId to a DIFFERENT segment than the flag originally pointed at', () => {
    const state = fresh_state();
    const segA = core.add_segment(state, { speaker: 'L', tStart: 0, tEnd: 1, text: 'segment a', final: true });
    const segB = core.add_segment(state, { speaker: 'R', tStart: 1, tEnd: 2, text: 'segment b', final: true });
    const flagId = core.add_flag(state, {
      t: 1.5,
      by: 'L',
      segmentId: segA,
      claimText: null,
      charStart: null,
      charEnd: null,
      source: 'key'
    });

    core.update_flag_claim(state, flagId, { segmentId: segB, claimText: 'segment b', charStart: 0, charEnd: 9 });

    expect(state.session.flags[0].segmentId).toBe(segB);
  });

  it('is a no-op (no dirty bump) for an unknown flag id', () => {
    const state = fresh_state();
    const dirtyBefore = state.dirty;
    const changed = core.update_flag_claim(state, 'nope', {
      segmentId: null,
      claimText: 'x',
      charStart: 0,
      charEnd: 1
    });
    expect(changed).toBe(false);
    expect(state.dirty).toBe(dirtyBefore);
  });
});

describe('session_store_core: flags_for', () => {
  it('filters by speaker and sorts descending by t', () => {
    const state = fresh_state();
    core.add_flag(state, { t: 1, by: 'L', segmentId: null, claimText: null, charStart: null, charEnd: null, source: 'key' });
    core.add_flag(state, { t: 5, by: 'R', segmentId: null, claimText: null, charStart: null, charEnd: null, source: 'key' });
    core.add_flag(state, { t: 3, by: 'L', segmentId: null, claimText: null, charStart: null, charEnd: null, source: 'key' });
    core.add_flag(state, { t: 8, by: 'L', segmentId: null, claimText: null, charStart: null, charEnd: null, source: 'key' });

    const lFlags = core.flags_for(state, 'L');
    expect(lFlags.map((f) => f.t)).toEqual([8, 3, 1]);

    const rFlags = core.flags_for(state, 'R');
    expect(rFlags.map((f) => f.t)).toEqual([5]);
  });

  it('returns an empty array when there are no flags for that speaker', () => {
    const state = fresh_state();
    expect(core.flags_for(state, 'L')).toEqual([]);
  });
});

describe('session_store_core: start_pause / end_pause (v0.3 train-fixes Part B)', () => {
  it('start_pause opens a pause with the p prefix, null tEnd, and bumps dirty', () => {
    const state = fresh_state();
    const id = core.start_pause(state, 12.5);
    expect(id).toBe('p1');
    expect(state.session.pauses).toEqual([{ id: 'p1', tStart: 12.5, tEnd: null }]);
    expect(state.dirty).toBe(1);
  });

  it('end_pause closes the currently-open pause by tEnd and bumps dirty', () => {
    const state = fresh_state();
    core.start_pause(state, 12.5);
    const dirtyBefore = state.dirty;
    const changed = core.end_pause(state, 40.5);
    expect(changed).toBe(true);
    expect(state.session.pauses).toEqual([{ id: 'p1', tStart: 12.5, tEnd: 40.5 }]);
    expect(state.dirty).toBe(dirtyBefore + 1);
  });

  it('end_pause is a no-op (no dirty bump) when there is no open pause', () => {
    const state = fresh_state();
    const dirtyBefore = state.dirty;
    expect(core.end_pause(state, 10)).toBe(false);
    expect(state.dirty).toBe(dirtyBefore);

    // also a no-op once the only pause is already closed
    core.start_pause(state, 1);
    core.end_pause(state, 2);
    const dirtyBefore2 = state.dirty;
    expect(core.end_pause(state, 3)).toBe(false);
    expect(state.dirty).toBe(dirtyBefore2);
  });

  it('assigns increasing ids across multiple pause/resume cycles', () => {
    const state = fresh_state();
    core.start_pause(state, 1);
    core.end_pause(state, 2);
    const id2 = core.start_pause(state, 5);
    expect(id2).toBe('p2');
    expect(state.session.pauses).toHaveLength(2);
  });
});

describe('session_store_core: set_audio_file', () => {
  it('sets session.audioFile and bumps dirty', () => {
    const state = fresh_state();
    expect(state.session.audioFile).toBeNull();
    const dirtyBefore = state.dirty;
    core.set_audio_file(state, 'audio.webm');
    expect(state.session.audioFile).toBe('audio.webm');
    expect(state.dirty).toBe(dirtyBefore + 1);
  });

  it('can clear audioFile back to null and still bumps dirty', () => {
    const state = fresh_state();
    core.set_audio_file(state, 'audio.webm');
    const dirtyBefore = state.dirty;
    core.set_audio_file(state, null);
    expect(state.session.audioFile).toBeNull();
    expect(state.dirty).toBe(dirtyBefore + 1);
  });
});
