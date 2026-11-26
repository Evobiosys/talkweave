// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { content_tokens, find_related_segments, tokenize } from '../app/src/lib/retrieval';
import type { Segment } from '../shared/model';

function seg(overrides: Partial<Segment>): Segment {
  return {
    id: 's1',
    speaker: 'L',
    tStart: 0,
    tEnd: 1,
    text: 'hello',
    final: true,
    ...overrides
  };
}

describe('tokenize / content_tokens', () => {
  it('lowercases and splits on non-word runs, keeping internal apostrophes', () => {
    expect(tokenize("Don't Panic!")).toEqual(["don't", 'panic']);
  });

  it('strips stopwords and single-letter tokens, keeps content words', () => {
    expect(content_tokens('The quick brown fox jumps over the lazy dog')).toEqual([
      'quick', 'brown', 'fox', 'jumps', 'lazy', 'dog'
    ]);
  });
});

describe('find_related_segments', () => {
  it('returns [] for an empty or all-stopword query', () => {
    const segments = [seg({ id: 's1', text: 'the revenue grew significantly last quarter' })];
    expect(find_related_segments('', segments)).toEqual([]);
    expect(find_related_segments('the a of it', segments)).toEqual([]);
  });

  it('returns [] when there is nothing to search', () => {
    expect(find_related_segments('quarterly revenue growth', [])).toEqual([]);
  });

  it('matches an exact repeat of the highlighted passage elsewhere, scored near the top', () => {
    const passage = 'the museum funding proposal got rejected by the city council last month';
    const segments = [
      seg({ id: 's1', text: passage }),
      seg({ id: 's2', text: 'unrelated chat about the weather and the weekend plans' }),
      seg({ id: 's3', text: passage })
    ];
    const matches = find_related_segments(passage, segments, { excludeSegmentId: 's1' });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].segment.id).toBe('s3');
    expect(matches[0].score).toBeCloseTo(1, 5);
    expect(matches.find((m) => m.segment.id === 's2')).toBeUndefined();
  });

  it('matches a paraphrase that reuses most of the same content words', () => {
    const query = 'the quarterly revenue grew by ten percent last year';
    const paraphrase = 'revenue increased about ten percent compared to last year, quarter over quarter';
    const segments = [
      seg({ id: 's1', text: paraphrase }),
      seg({ id: 's2', text: 'we should get lunch before the meeting starts' })
    ];
    const matches = find_related_segments(query, segments);
    expect(matches.map((m) => m.segment.id)).toEqual(['s1']);
    expect(matches[0].score).toBeGreaterThan(0.4);
  });

  it('matches a real recurring passage restated with different filler around the same distinctive content (E2E fixture regression)', () => {
    // Mirrors the actual "ask the conversation" E2E proof fixture
    // (scratchpad/build_seed_session.mjs): the highlighted passage
    // shares only about a third of ITS OWN distinctive vocabulary with
    // the later restatement — several of its words ("grant", "enough",
    // "finish", "map", "run", "pilot") never recur anywhere else at all,
    // which drags the containment denominator up. This is what the
    // 0.35 -> 0.3 threshold calibration (see RETRIEVAL_DEFAULT_MIN_SCORE's
    // doc comment) exists to keep matching — a regression here means a
    // real, undeniable recurrence silently stopped being found.
    const passage =
      'Forty thousand euros is the grant, enough to finish the map and run the Kapfenberg pilot through a feasibility study.';
    const segments = [
      seg({ id: 's1', tStart: 0, text: "So I've been mapping empty buildings across Styria that could become affordable co-living spaces." }),
      seg({ id: 's2', tStart: 8, text: 'Empty buildings? Like, actually empty, or empty on paper?' }),
      seg({ id: 's3', tStart: 12, text: passage }),
      seg({ id: 's4', tStart: 24, text: 'Yeah, I know, I think that is really interesting actually.' }),
      seg({ id: 's5', tStart: 28, text: 'Graz is around two hundred ninety thousand people, second largest city in Austria after Vienna.' }),
      seg({ id: 's6', tStart: 34, text: 'Yeah, I know, I think that is really surprising to me.' }),
      seg({ id: 's7', tStart: 38, text: 'The old textile factory in Kapfenberg has been vacant since 2011, about four thousand square meters.' }),
      seg({ id: 's8', tStart: 46, text: 'Yeah, I know, I think that is really a big deal honestly.' }),
      seg({
        id: 's9',
        tStart: 50,
        text: "If the feasibility study says no, we've spent forty thousand euros to learn that and we pick a different building."
      }),
      seg({ id: 's10', tStart: 62, text: 'Fair. I guess my real worry is that this becomes another well-meaning map nobody acts on.' })
    ];
    const matches = find_related_segments(passage, segments, { excludeSegmentId: 's3' });
    expect(matches.map((m) => m.segment.id)).toEqual(['s9']);
  });

  it('still matches a highlighted topic embedded in a much longer candidate segment (containment, not Jaccard)', () => {
    const query = 'the museum funding proposal';
    const longCandidateExtra =
      'so anyway before we get to that, we spent like twenty minutes yesterday going back and forth about ' +
      'catering and parking and whether the projector in the east wing actually works this time, and then finally';
    const longCandidate = `${longCandidateExtra} the museum funding proposal came up again and everyone had opinions`;
    const segments = [
      seg({ id: 's1', text: longCandidate }),
      seg({ id: 's2', text: 'totally unrelated small talk about coffee and traffic' })
    ];
    const matches = find_related_segments(query, segments);
    expect(matches.map((m) => m.segment.id)).toEqual(['s1']);
    // Containment score should stay high even though the candidate is
    // many times longer than the query — a plain Jaccard/union score
    // would have been crushed by all the extra words instead.
    expect(matches[0].score).toBeGreaterThan(0.8);
  });

  it('does not match on session-ubiquitous filler words alone', () => {
    // "yeah", "know", "think", "really" recur in nearly every segment of
    // this little corpus — exactly the case a plain stopword list can't
    // catch (none of these are conventional stopwords) but idf weighting
    // must: the query built only from filler must not match a segment
    // that shares only that same filler, with no real topic overlap.
    const filler = (topic: string) => `yeah I know, I think that's really ${topic}`;
    const segments = [
      seg({ id: 's1', text: filler('interesting actually') }),
      seg({ id: 's2', text: filler('surprising to me') }),
      seg({ id: 's3', text: filler('a big deal honestly') }),
      seg({ id: 's4', text: filler('not what I expected') })
    ];
    const query = "yeah I know, I think that's really something";
    const matches = find_related_segments(query, segments);
    expect(matches).toEqual([]);
  });

  it('excludes the source segment itself when excludeSegmentId is given', () => {
    const passage = 'the museum funding proposal got rejected';
    // A second, unrelated segment gives the corpus enough contrast for
    // idf weighting to mean anything (see this file's header comment on
    // why a single-segment/all-identical corpus is a degenerate case for
    // a corpus-relative idf measure, distinct from the real bug this test
    // targets: exclusion).
    const segments = [seg({ id: 's1', text: passage }), seg({ id: 's2', text: 'totally unrelated small talk' })];
    expect(find_related_segments(passage, segments, { excludeSegmentId: 's1' })).toEqual([]);
    expect(find_related_segments(passage, segments)).not.toEqual([]);
  });

  it('never returns a non-final (partial, still-live) segment', () => {
    const passage = 'the museum funding proposal got rejected';
    const segments = [seg({ id: 's1', text: passage, final: false })];
    expect(find_related_segments(passage, segments)).toEqual([]);
  });

  it('orders multiple matches by score descending, ties broken by earliest tStart', () => {
    const query = 'the museum funding proposal was controversial';
    const segments = [
      seg({ id: 'filler1', tStart: 0, text: 'so anyway lets grab coffee before the next call' }),
      seg({ id: 'filler2', tStart: 1, text: 'traffic was awful on the way in this morning' }),
      seg({ id: 'weak', tStart: 5, text: 'there was some museum funding thing mentioned once but nothing serious' }),
      seg({ id: 'strong-later', tStart: 20, text: 'the museum funding proposal was extremely controversial' }),
      seg({ id: 'strong-earlier', tStart: 10, text: 'the museum funding proposal was extremely controversial' }),
      seg({ id: 'filler3', tStart: 2, text: 'someone forgot to book the conference room again' })
    ];
    const matches = find_related_segments(query, segments);
    expect(matches.map((m) => m.segment.id)).toEqual(['strong-earlier', 'strong-later', 'weak']);
  });

  it('respects limit', () => {
    const query = 'the museum funding proposal';
    const matching = Array.from({ length: 5 }, (_, i) =>
      seg({ id: `s${i}`, text: 'the museum funding proposal came up again' })
    );
    const segments = [...matching, seg({ id: 'filler', text: 'unrelated small talk about the weekend' })];
    expect(find_related_segments(query, segments, { limit: 2 })).toHaveLength(2);
  });
});
