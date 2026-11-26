// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  build_claim_prompt,
  full_sentences,
  locate_claim,
  most_recent_final_segment_before,
  sentence_fallback,
  strip_wrapping_quotes
} from '../server/lib/claim.mjs';

function seg(id, speaker, tStart, tEnd, text, final = true) {
  return { id, speaker, tStart, tEnd, text, final };
}

describe('most_recent_final_segment_before', () => {
  it('returns the segment with the largest tStart strictly before flagT', () => {
    const segments = [seg('s1', 'L', 0, 2, 'first'), seg('s2', 'R', 2, 4, 'second'), seg('s3', 'L', 4, 6, 'third')];
    expect(most_recent_final_segment_before(segments, 5)?.id).toBe('s3');
    expect(most_recent_final_segment_before(segments, 4)?.id).toBe('s2');
    expect(most_recent_final_segment_before(segments, 2)?.id).toBe('s1');
  });

  it('ignores non-final segments', () => {
    const segments = [seg('s1', 'L', 0, 2, 'final one'), seg('s2', 'R', 2, 4, 'partial', false)];
    expect(most_recent_final_segment_before(segments, 5)?.id).toBe('s1');
  });

  it('returns undefined when no eligible segment exists (edge case: no other-speaker segment)', () => {
    expect(most_recent_final_segment_before([], 10)).toBeUndefined();
    const segments = [seg('s1', 'L', 5, 6, 'too late')];
    expect(most_recent_final_segment_before(segments, 5)).toBeUndefined();
  });

  it('is defensive against out-of-order input (not just trusting array order)', () => {
    const segments = [seg('s3', 'L', 4, 6, 'third'), seg('s1', 'L', 0, 2, 'first'), seg('s2', 'R', 2, 4, 'second')];
    expect(most_recent_final_segment_before(segments, 10)?.id).toBe('s3');
  });
});

describe('build_claim_prompt', () => {
  it('includes only final segments strictly before flagT, in chronological order', () => {
    const context = [
      seg('s1', 'L', 0, 2, 'Rent control works.'),
      seg('s2', 'R', 2, 4, 'I disagree with that.'),
      seg('s3', 'L', 4, 6, 'too late', true) // at/after flagT — excluded
    ];
    const prompt = build_claim_prompt(context, 4, undefined);
    expect(prompt).toContain('L: Rent control works.');
    expect(prompt).toContain('R: I disagree with that.');
    expect(prompt.indexOf('Rent control')).toBeLessThan(prompt.indexOf('I disagree'));
    expect(prompt).not.toContain('too late');
  });

  it('appends principles as extra guidance when given, and omits the line when blank/omitted', () => {
    const context = [seg('s1', 'L', 0, 2, 'text')];
    const withPrinciples = build_claim_prompt(context, 5, '  focus on economic claims  ');
    expect(withPrinciples).toContain('Additional guidance: focus on economic claims');

    const noPrinciples = build_claim_prompt(context, 5, undefined);
    expect(noPrinciples).not.toContain('Additional guidance');

    const blankPrinciples = build_claim_prompt(context, 5, '   ');
    expect(blankPrinciples).not.toContain('Additional guidance');
  });

  it('instructs the model to return only the verbatim claim', () => {
    const prompt = build_claim_prompt([], 1, undefined);
    expect(prompt.toLowerCase()).toContain('verbatim');
    expect(prompt.toLowerCase()).toContain('word-for-word');
  });

  it('defensively truncates to the last CLAIM_CONTEXT_WINDOW_SEGMENTS (12) segments nearest flagT (review fix round 1, Important 2)', () => {
    // Marker format avoids substring collisions between e.g. "turn-1-mark"
    // and "turn-10-mark" — a plain numeric suffix would make `not.toContain`
    // assertions for single-digit turns spuriously pass/fail against the
    // double-digit ones.
    const context = Array.from({ length: 20 }, (_, i) =>
      seg(`s${i}`, i % 2 === 0 ? 'L' : 'R', i, i + 1, `turn-${i}-mark`)
    );
    const prompt = build_claim_prompt(context, 20, undefined);
    for (let i = 0; i < 8; i++) {
      expect(prompt).not.toContain(`turn-${i}-mark`);
    }
    for (let i = 8; i < 20; i++) {
      expect(prompt).toContain(`turn-${i}-mark`);
    }
  });
});

describe('strip_wrapping_quotes', () => {
  it('strips a matching pair of straight double quotes', () => {
    expect(strip_wrapping_quotes('"the exact claim"')).toBe('the exact claim');
  });

  it('strips a matching pair of straight single quotes', () => {
    expect(strip_wrapping_quotes("'the exact claim'")).toBe('the exact claim');
  });

  it('strips a matching pair of curly quotes', () => {
    expect(strip_wrapping_quotes('“the exact claim”')).toBe('the exact claim');
  });

  it('leaves text unwrapped when only one side has a quote', () => {
    expect(strip_wrapping_quotes('"the exact claim')).toBe('"the exact claim');
    expect(strip_wrapping_quotes('the exact claim"')).toBe('the exact claim"');
  });

  it('leaves plain text untouched', () => {
    expect(strip_wrapping_quotes('the exact claim')).toBe('the exact claim');
  });
});

describe('locate_claim', () => {
  it('finds the claim within a single eligible segment and returns its offsets', () => {
    const segments = [seg('s1', 'R', 0, 3, 'I think rent control works well here.')];
    const located = locate_claim(segments, 'rent control works well', 5);
    expect(located).toEqual({ segmentId: 's1', charStart: 8, charEnd: 31 });
  });

  it('returns null when the claim is not found verbatim in any eligible segment', () => {
    const segments = [seg('s1', 'R', 0, 3, 'a completely different sentence')];
    expect(locate_claim(segments, 'rent control works', 5)).toBeNull();
  });

  it('edge case: claim appearing in two segments picks the nearest-before-flagT occurrence', () => {
    const segments = [
      seg('s1', 'L', 0, 2, 'earlier: the market always corrects itself eventually.'),
      seg('s2', 'R', 2, 4, 'reply'),
      seg('s3', 'L', 4, 6, 'later: the market always corrects itself eventually.')
    ];
    const located = locate_claim(segments, 'the market always corrects itself eventually', 7);
    expect(located?.segmentId).toBe('s3');
  });

  it('excludes segments at/after flagT even if they contain the claim', () => {
    const segments = [
      seg('s1', 'L', 0, 2, 'before the flag: nothing useful here'),
      seg('s2', 'R', 5, 7, 'after the flag: a specific quote appears here')
    ];
    expect(locate_claim(segments, 'a specific quote appears here', 5)).toBeNull();
  });
});

describe('full_sentences', () => {
  it('splits multi-sentence text into full sentences with correct offsets', () => {
    const text = 'First point. Second point! Third point?';
    const sentences = full_sentences(text);
    expect(sentences.map((s) => s.text)).toEqual(['First point.', 'Second point!', 'Third point?']);
    for (const s of sentences) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('excludes a trailing unpunctuated fragment', () => {
    const text = 'Done deal. but this trails off without punctuation';
    const sentences = full_sentences(text);
    expect(sentences.map((s) => s.text)).toEqual(['Done deal.']);
  });

  it('returns an empty array for text with no terminal punctuation at all', () => {
    expect(full_sentences('no punctuation anywhere')).toEqual([]);
  });
});

describe('sentence_fallback', () => {
  it('returns the last full sentence of the most recent other-speaker segment (multi-sentence case)', () => {
    const segments = [seg('s1', 'R', 0, 3, 'First point. The real claim is this one.')];
    const fallback = sentence_fallback(segments, 5);
    expect(fallback).toEqual({ text: 'The real claim is this one.', segmentId: 's1', charStart: 13, charEnd: 40 });
  });

  it('falls back to the whole trimmed segment text when there is no terminal punctuation at all', () => {
    const segments = [seg('s1', 'R', 0, 3, '  an unpunctuated trailing thought  ')];
    const fallback = sentence_fallback(segments, 5);
    expect(fallback?.text).toBe('an unpunctuated trailing thought');
    expect(fallback?.segmentId).toBe('s1');
  });

  it('edge case: no other-speaker segment returns null', () => {
    expect(sentence_fallback([], 5)).toBeNull();
    const segments = [seg('s1', 'R', 5, 6, 'too late to count')];
    expect(sentence_fallback(segments, 5)).toBeNull();
  });

  it('returns null when the eligible segment is empty/whitespace-only', () => {
    const segments = [seg('s1', 'R', 0, 1, '   ')];
    expect(sentence_fallback(segments, 5)).toBeNull();
  });
});
