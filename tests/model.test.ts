// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { next_id } from '../shared/model';

describe('next_id', () => {
  it('starts at 1 when there are no existing ids', () => {
    expect(next_id('s', [])).toBe('s1');
  });

  it('returns one past the highest existing numeric suffix', () => {
    expect(next_id('s', ['s1', 's2', 's5'])).toBe('s6');
  });

  it('is not fooled by an id belonging to a different prefix that happens to start the same way', () => {
    // "s" must not match "sm1" — different entity kind, same leading letter.
    expect(next_id('s', ['sm1', 'sm2'])).toBe('s1');
    expect(next_id('sm', ['s1', 's2'])).toBe('sm1');
  });

  it('ignores malformed/non-numeric-suffix ids for the same prefix', () => {
    expect(next_id('f', ['f1', 'fx', 'f-3', 'f2'])).toBe('f3');
  });
});
