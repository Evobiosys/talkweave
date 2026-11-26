// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { build_summary_prompt, truncate_to_bullets } from '../server/lib/summary.mjs';

function seg(id, speaker, tStart, tEnd, text, final = true) {
  return { id, speaker, tStart, tEnd, text, final };
}

describe('build_summary_prompt', () => {
  it('includes only final segments overlapping [tFrom, tTo), in chronological order', () => {
    const segments = [
      seg('s1', 'L', 0, 10, 'too early'),
      seg('s2', 'R', 10, 20, 'in range one'),
      seg('s3', 'L', 20, 30, 'in range two'),
      seg('s4', 'R', 30, 40, 'too late'),
      seg('s5', 'L', 22, 24, 'partial in range', false)
    ];
    const prompt = build_summary_prompt(segments, 10, 30);
    expect(prompt).toContain('R: in range one');
    expect(prompt).toContain('L: in range two');
    expect(prompt.indexOf('in range one')).toBeLessThan(prompt.indexOf('in range two'));
    expect(prompt).not.toContain('too early');
    expect(prompt).not.toContain('too late');
    expect(prompt).not.toContain('partial in range');
  });

  it('asks for at most 3 bullets with no preamble', () => {
    const prompt = build_summary_prompt([], 0, 60);
    expect(prompt).toContain('at most 3');
    expect(prompt.toLowerCase()).toContain('bullet');
  });
});

describe('truncate_to_bullets', () => {
  it('passes through 3 or fewer non-empty lines unchanged', () => {
    const text = '- point one\n- point two';
    expect(truncate_to_bullets(text)).toBe('- point one\n- point two');
  });

  it('caps to the first 3 non-empty lines when the model returns more', () => {
    const text = '- one\n- two\n- three\n- four\n- five';
    expect(truncate_to_bullets(text)).toBe('- one\n- two\n- three');
  });

  it('drops blank lines when counting toward the cap', () => {
    const text = '- one\n\n- two\n\n\n- three\n- four';
    expect(truncate_to_bullets(text)).toBe('- one\n- two\n- three');
  });

  it('respects a custom max', () => {
    const text = '- one\n- two\n- three';
    expect(truncate_to_bullets(text, 1)).toBe('- one');
  });

  it('returns the trimmed original text when there are no non-empty lines', () => {
    expect(truncate_to_bullets('   \n  \n')).toBe('');
  });
});
