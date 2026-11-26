// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { decide_note_commit } from '../app/src/lib/note_helpers';

describe('note_helpers: decide_note_commit', () => {
  it('returns null for empty/whitespace-only input', () => {
    expect(decide_note_commit('', 'L', 5)).toBeNull();
    expect(decide_note_commit('   ', 'R', 5)).toBeNull();
  });

  it('commits a trimmed single-word note', () => {
    expect(decide_note_commit('  rent  ', 'L', 12.5)).toEqual({ t: 12.5, by: 'L', text: 'rent' });
  });

  it('commits a trimmed multi-word note (no hint mechanism — multi-word input commits plainly)', () => {
    expect(decide_note_commit('rent control policy', 'R', 30)).toEqual({ t: 30, by: 'R', text: 'rent control policy' });
  });

  it('trims surrounding whitespace before storing', () => {
    expect(decide_note_commit('   one two   ', 'L', 0)).toEqual({ t: 0, by: 'L', text: 'one two' });
  });
});
