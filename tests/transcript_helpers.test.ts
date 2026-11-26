// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  alignment_for,
  should_pin,
  format_ts,
  split_words,
  word_span,
  selection_span,
  highlighted_ranges,
  word_overlaps_ranges,
  speaker_for_segment
} from '../app/src/lib/transcript_helpers';
import type { Flag, Segment } from '../shared/model';

function seg(overrides: Partial<Segment>): Segment {
  return { id: 's1', speaker: 'L', tStart: 0, tEnd: 1, text: 'hello', final: true, ...overrides };
}

function flag(overrides: Partial<Flag>): Flag {
  return {
    id: 'f1',
    t: 0,
    by: 'L',
    segmentId: 's1',
    claimText: null,
    charStart: null,
    charEnd: null,
    source: 'key',
    ...overrides
  };
}

describe('transcript_helpers: alignment_for', () => {
  it('maps L to left, R to right, null to center', () => {
    expect(alignment_for('L')).toBe('left');
    expect(alignment_for('R')).toBe('right');
    expect(alignment_for(null)).toBe('center');
  });
});

describe('transcript_helpers: format_ts', () => {
  it('formats zero as 00:00', () => {
    expect(format_ts(0)).toBe('00:00');
  });

  it('floors rather than rounds — 59.9s stays under a minute', () => {
    expect(format_ts(59.9)).toBe('00:59');
  });

  it('formats exactly one minute', () => {
    expect(format_ts(60)).toBe('01:00');
  });

  it('does not cap minutes past an hour (mm:ss only, no hours field)', () => {
    expect(format_ts(3661)).toBe('61:01');
  });

  it('clamps negative and NaN input to 00:00', () => {
    expect(format_ts(-5)).toBe('00:00');
    expect(format_ts(NaN)).toBe('00:00');
  });
});

describe('transcript_helpers: split_words', () => {
  it('splits simple text and reports correct offsets', () => {
    const spans = split_words('hello world');
    expect(spans).toEqual([
      { word: 'hello', ci: 0 },
      { word: 'world', ci: 6 }
    ]);
  });

  it('handles multi-space runs, tabs, and leading/trailing whitespace without desync', () => {
    const text = '  hello   world\tthere  ';
    const spans = split_words(text);
    for (const s of spans) {
      expect(text.slice(s.ci, s.ci + s.word.length)).toBe(s.word);
    }
    expect(spans.map((s) => s.word)).toEqual(['hello', 'world', 'there']);
  });

  it('produces offsets that round-trip via slice for a fixture with unicode, including an astral (surrogate-pair) char', () => {
    const text = 'café naïve 100€ word😀 end';
    const spans = split_words(text);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(text.slice(s.ci, s.ci + s.word.length)).toBe(s.word);
    }
  });

  it('returns an empty array for empty or all-whitespace text', () => {
    expect(split_words('')).toEqual([]);
    expect(split_words('   \t  ')).toEqual([]);
  });
});

describe('transcript_helpers: should_pin', () => {
  it('stays pinned when content is shorter than the viewport, regardless of scrollTop', () => {
    const metrics = { scrollTop: 0, scrollHeight: 300, clientHeight: 600 };
    expect(should_pin(metrics)).toBe(true);
  });

  it('is not pinned when scrolled away from the bottom past the threshold (transition: pull away)', () => {
    // scrollHeight 1000, clientHeight 600 -> max scrollTop 400 (bottom).
    // scrollTop 100 -> distance from bottom = 300, past a 24px threshold.
    const metrics = { scrollTop: 100, scrollHeight: 1000, clientHeight: 600 };
    expect(should_pin(metrics)).toBe(false);
  });

  it('is pinned once scrolled back within the threshold of the bottom (transition: return)', () => {
    const metrics = { scrollTop: 390, scrollHeight: 1000, clientHeight: 600 };
    expect(should_pin(metrics)).toBe(true);
  });

  it('honors a custom threshold', () => {
    const metrics = { scrollTop: 350, scrollHeight: 1000, clientHeight: 600 };
    // distance from bottom = 50
    expect(should_pin(metrics, 24)).toBe(false);
    expect(should_pin(metrics, 100)).toBe(true);
  });

  it('treats exact-bottom scrollTop as pinned', () => {
    const metrics = { scrollTop: 400, scrollHeight: 1000, clientHeight: 600 };
    expect(should_pin(metrics)).toBe(true);
  });
});

describe('transcript_helpers: word_span (dblclick word case)', () => {
  it('computes charStart/charEnd from a split_words offset and the word text', () => {
    // "the numbers on slide four" -> "numbers" starts at index 4.
    expect(word_span(4, 'numbers')).toEqual({ charStart: 4, charEnd: 11 });
  });

  it('handles a zero offset and a single-char word', () => {
    expect(word_span(0, 'I')).toEqual({ charStart: 0, charEnd: 1 });
  });
});

describe('transcript_helpers: selection_span (dblclick selection case)', () => {
  it('normalizes a forward selection', () => {
    expect(selection_span(4, 11, 20)).toEqual({ charStart: 4, charEnd: 11 });
  });

  it('normalizes a backwards (right-to-left drag) selection', () => {
    expect(selection_span(11, 4, 20)).toEqual({ charStart: 4, charEnd: 11 });
  });

  it('clamps to the segment text length', () => {
    expect(selection_span(15, 30, 20)).toEqual({ charStart: 15, charEnd: 20 });
  });

  it('clamps a negative start to 0', () => {
    expect(selection_span(-5, 5, 20)).toEqual({ charStart: 0, charEnd: 5 });
  });

  it('returns null for a collapsed selection', () => {
    expect(selection_span(5, 5, 20)).toBeNull();
  });

  it('returns null when clamping leaves nothing (fully out of bounds)', () => {
    expect(selection_span(25, 30, 20)).toBeNull();
  });
});

describe('transcript_helpers: highlighted_ranges', () => {
  it('returns an empty array when no flags target the segment', () => {
    expect(highlighted_ranges('s1', [flag({ segmentId: 's2' })], 20)).toEqual([]);
  });

  it('returns an empty array for a zero-length segment', () => {
    expect(highlighted_ranges('s1', [flag({ segmentId: 's1' })], 0)).toEqual([]);
  });

  it('a flag with null charStart/charEnd highlights the whole segment', () => {
    expect(highlighted_ranges('s1', [flag({ segmentId: 's1', charStart: null, charEnd: null })], 12)).toEqual([
      { charStart: 0, charEnd: 12 }
    ]);
  });

  it('whole-segment wins outright over a narrower flag on the same segment', () => {
    const flags = [
      flag({ id: 'f1', segmentId: 's1', charStart: 2, charEnd: 5 }),
      flag({ id: 'f2', segmentId: 's1', charStart: null, charEnd: null })
    ];
    expect(highlighted_ranges('s1', flags, 12)).toEqual([{ charStart: 0, charEnd: 12 }]);
  });

  it('a single partial-span flag highlights just that range', () => {
    expect(highlighted_ranges('s1', [flag({ segmentId: 's1', charStart: 3, charEnd: 9 })], 20)).toEqual([
      { charStart: 3, charEnd: 9 }
    ]);
  });

  it('merges overlapping ranges from multiple flags', () => {
    const flags = [
      flag({ id: 'f1', segmentId: 's1', charStart: 0, charEnd: 5 }),
      flag({ id: 'f2', segmentId: 's1', charStart: 3, charEnd: 8 })
    ];
    expect(highlighted_ranges('s1', flags, 20)).toEqual([{ charStart: 0, charEnd: 8 }]);
  });

  it('merges touching (adjacent) ranges into one', () => {
    const flags = [
      flag({ id: 'f1', segmentId: 's1', charStart: 0, charEnd: 5 }),
      flag({ id: 'f2', segmentId: 's1', charStart: 5, charEnd: 10 })
    ];
    expect(highlighted_ranges('s1', flags, 20)).toEqual([{ charStart: 0, charEnd: 10 }]);
  });

  it('keeps non-overlapping ranges separate, sorted by position', () => {
    const flags = [
      flag({ id: 'f1', segmentId: 's1', charStart: 10, charEnd: 15 }),
      flag({ id: 'f2', segmentId: 's1', charStart: 0, charEnd: 3 })
    ];
    expect(highlighted_ranges('s1', flags, 20)).toEqual([
      { charStart: 0, charEnd: 3 },
      { charStart: 10, charEnd: 15 }
    ]);
  });
});

describe('transcript_helpers: word_overlaps_ranges', () => {
  const ranges = [
    { charStart: 4, charEnd: 11 },
    { charStart: 15, charEnd: 19 }
  ];

  it('true for a word fully inside a range', () => {
    expect(word_overlaps_ranges(4, 11, ranges)).toBe(true);
  });

  it('true for a word only partially overlapping a range', () => {
    expect(word_overlaps_ranges(8, 13, ranges)).toBe(true);
  });

  it('false for a word entirely between ranges', () => {
    expect(word_overlaps_ranges(11, 15, ranges)).toBe(false);
  });

  it('false when there are no ranges', () => {
    expect(word_overlaps_ranges(0, 5, [])).toBe(false);
  });
});

describe('speaker_for_segment', () => {
  const segments = [seg({ id: 's1', speaker: 'L' }), seg({ id: 's2', speaker: 'R' }), seg({ id: 's3', speaker: null })];

  it('returns the matching segment\'s speaker', () => {
    expect(speaker_for_segment('s1', segments)).toBe('L');
    expect(speaker_for_segment('s2', segments)).toBe('R');
  });

  it('returns null for an unattributed segment — a real, legitimate state, not treated as "not found"', () => {
    expect(speaker_for_segment('s3', segments)).toBeNull();
  });

  it('returns null for a segment id that does not exist', () => {
    expect(speaker_for_segment('nope', segments)).toBeNull();
  });

  it('returns null for a null segment id', () => {
    expect(speaker_for_segment(null, segments)).toBeNull();
  });
});
