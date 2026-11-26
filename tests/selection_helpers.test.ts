// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { normalize_selected_text, SELECTION_TEXT_MAX } from '../app/src/lib/selection_helpers';

describe('selection_helpers: normalize_selected_text', () => {
  it('returns short plain text unchanged', () => {
    expect(normalize_selected_text('the budget was cut by ten percent')).toBe('the budget was cut by ten percent');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalize_selected_text('   hello there   ')).toBe('hello there');
  });

  it('collapses embedded newlines into a single space', () => {
    expect(normalize_selected_text('the budget\nwas cut\nby ten percent')).toBe('the budget was cut by ten percent');
  });

  it('collapses tabs and runs of repeated spaces into a single space', () => {
    expect(normalize_selected_text('the budget\t\twas   cut')).toBe('the budget was cut');
  });

  it('collapses a mix of newlines, tabs and spaces in one pass', () => {
    expect(normalize_selected_text('  the  \n\t budget\n\nwas cut  ')).toBe('the budget was cut');
  });

  it('returns empty string for a selection that is only whitespace', () => {
    expect(normalize_selected_text('   \n\t  \n  ')).toBe('');
  });

  it('returns empty string for an empty selection', () => {
    expect(normalize_selected_text('')).toBe('');
  });

  it('caps the result at the default max length, with an ellipsis', () => {
    const long = 'word '.repeat(200).trim();
    const result = normalize_selected_text(long);
    expect(result.length).toBeLessThanOrEqual(SELECTION_TEXT_MAX);
    expect(result.endsWith('…')).toBe(true);
  });

  it('honors a caller-supplied max', () => {
    const result = normalize_selected_text('one two three four five', 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves text under the cap without an ellipsis', () => {
    const text = 'a short highlighted claim';
    expect(normalize_selected_text(text, SELECTION_TEXT_MAX)).toBe(text);
  });
});
