// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { build_freeform_prompt, build_same_topic_prompt } from '../server/lib/ask.mjs';

function candidate(overrides) {
  return { segmentId: 's1', speaker: 'L', tStart: 0, text: 'hello', ...overrides };
}

describe('build_same_topic_prompt', () => {
  it('includes both passages and asks for a yes/no + one-sentence answer', () => {
    const prompt = build_same_topic_prompt('the museum funding proposal was rejected', 'earlier they discussed museum funding');
    expect(prompt).toContain('the museum funding proposal was rejected');
    expect(prompt).toContain('earlier they discussed museum funding');
    expect(prompt).toContain('"yes" or "no"');
    expect(prompt).toContain('SAME topic');
  });
});

describe('build_freeform_prompt', () => {
  it('renders candidates as SPEAKER: text, chronological, and includes the question', () => {
    const prompt = build_freeform_prompt('who proposed the museum funding?', [
      candidate({ segmentId: 's2', speaker: 'R', tStart: 20, text: 'later remark' }),
      candidate({ segmentId: 's1', speaker: 'L', tStart: 5, text: 'earlier remark' })
    ]);
    expect(prompt.indexOf('earlier remark')).toBeLessThan(prompt.indexOf('later remark'));
    expect(prompt).toContain('L: earlier remark');
    expect(prompt).toContain('R: later remark');
    expect(prompt).toContain('who proposed the museum funding?');
    expect(prompt).toContain('ONLY the transcript excerpts');
  });

  it('renders an unattributed candidate speaker as "?" rather than the literal string "null"', () => {
    const prompt = build_freeform_prompt('q', [candidate({ speaker: null, text: 'unattributed line' })]);
    expect(prompt).toContain('?: unattributed line');
  });

  it('is honest about an empty candidate list rather than fabricating transcript content', () => {
    const prompt = build_freeform_prompt('q', []);
    expect(prompt).toContain('no matching excerpts were found');
  });

  it('caps to windowSize candidates', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => candidate({ segmentId: `s${i}`, tStart: i, text: `line ${i}` }));
    const prompt = build_freeform_prompt('q', candidates, 2);
    expect(prompt).toContain('line 0');
    expect(prompt).toContain('line 1');
    expect(prompt).not.toContain('line 2');
  });
});
