// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { serialize_session, parse_session } from '../shared/session_md';
import type { Session } from '../shared/model';

/**
 * Rich fixture exercising every entity type, both speakers, the null
 * speaker ('?'), a non-final ("interim") segment, an orphan flag
 * (segmentId: null), a flag with no span/claimText, a flag with an empty
 * (not null) claimText, escaped newlines, a colon inside free text, both
 * summary triggers, and both a completed and a still-running fact-check
 * (covering quick: null, deep.text: null, deep.etaMs both set and null).
 *
 * Flags/notes are listed in "document order" (grouped by the segment they
 * attach to, orphans last) per the invariant documented in session_md.ts.
 */
function rich_fixture(): Session {
  return {
    id: 'sess_2026-08-18T03-55-00',
    startedAt: '2026-08-18T03:55:00+02:00',
    title: 'Housing pilot: check-in',
    names: { L: 'Jakob', R: 'Guest' },
    segments: [
      {
        id: 's1',
        speaker: 'L',
        tStart: 12.4,
        tEnd: 18.9,
        text: 'The housing pilot covers nine thousand buildings.',
        final: true
      },
      {
        id: 's2',
        speaker: null,
        tStart: 19.2,
        tEnd: 24.0,
        text: 'But the vacancy numbers seemed off: really?\nWait, let me check.',
        final: false
      }
    ],
    flags: [
      {
        id: 'f1',
        t: 15.1,
        by: 'R',
        segmentId: 's1',
        claimText: 'housing pilot covers nine thousand',
        charStart: 4,
        charEnd: 37,
        source: 'key'
      },
      {
        id: 'f2',
        t: 20.0,
        by: 'L',
        segmentId: 's2',
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'dblclick'
      },
      {
        id: 'f3',
        t: 50.0,
        by: 'R',
        segmentId: null,
        claimText: '',
        charStart: null,
        charEnd: null,
        source: 'ai'
      }
    ],
    notes: [
      { id: 'n1', t: 16.0, by: 'R', text: 'vacancy?' },
      { id: 'n2', t: 21.0, by: 'L', text: 'double-check: source needed' }
    ],
    // v0.3 train-fixes Part B: one resolved pause (real duration 17.5s —
    // see shared/model.ts's `Pause` doc comment for why tEnd - tStart IS
    // that duration, not another session-clock reading) and one still
    // open (tEnd: null), covering both serialize/parse branches.
    pauses: [
      { id: 'p1', tStart: 25.0, tEnd: 42.5 },
      { id: 'p2', tStart: 60.0, tEnd: null }
    ],
    summaries: [
      {
        id: 'sm1',
        tFrom: 0,
        tTo: 900,
        text: 'Housing overview.\nVacancy numbers questioned.',
        trigger: 'interval'
      },
      { id: 'sm2', tFrom: 900, tTo: 1800, text: 'Wrap-up: still contested.', trigger: 'manual' }
    ],
    factChecks: [
      {
        id: 'fc1',
        t: 301.2,
        by: 'L',
        question: 'Is Graz bigger than Linz?',
        quick: { text: 'Yes — Graz ~300k vs Linz ~210k.', model: 'qwen3:4b', ms: 1200 },
        deep: {
          status: 'done',
          text: 'Confirmed: Graz is larger.\nSource: Statistik Austria.',
          model: 'qwen3.6-27b-iq4',
          etaMs: null,
          contradicts: false
        }
      },
      {
        id: 'fc2',
        t: 550.5,
        by: 'R',
        question: 'Did the pilot start in 2024?',
        quick: null,
        deep: {
          status: 'running',
          text: null,
          model: 'qwen3.6-27b-iq4',
          etaMs: 5000,
          contradicts: true
        }
      }
    ],
    audioFile: 'audio.webm'
  };
}

describe('session_md: round-trip', () => {
  it('serialize -> parse deep-equals the original rich fixture', () => {
    const original = rich_fixture();
    const md = serialize_session(original);
    const parsed = parse_session(md);
    expect(parsed).toStrictEqual(original);
  });

  it('is idempotent: re-serializing the parsed session yields byte-identical markdown', () => {
    const original = rich_fixture();
    const md = serialize_session(original);
    const md2 = serialize_session(parse_session(md));
    expect(md2).toBe(md);
  });

  it('round-trips a session with no segments (notes/flags stay orphaned, audioFile null)', () => {
    const original: Session = {
      id: 'sess_empty',
      startedAt: '2026-08-18T00:00:00Z',
      title: '',
      names: { L: 'A', R: 'B' },
      segments: [],
      flags: [
        {
          id: 'f1',
          t: 1,
          by: 'L',
          segmentId: null,
          claimText: 'x',
          charStart: null,
          charEnd: null,
          source: 'ai'
        }
      ],
      notes: [{ id: 'n1', t: 2, by: 'R', text: 'y' }],
      pauses: [],
      summaries: [],
      factChecks: [],
      audioFile: null
    };
    const parsed = parse_session(serialize_session(original));
    expect(parsed).toStrictEqual(original);
  });

  it('produces the documented markdown shape for the common (non-edge-case) fields', () => {
    const md = serialize_session(rich_fixture());
    expect(md).toContain('# Talkweave — Housing pilot: check-in');
    expect(md).toContain('names: L=Jakob R=Guest');
    expect(md).toContain('audio: audio.webm');
    expect(md).toContain('- [12.4–18.9] L s1: The housing pilot covers nine thousand buildings.');
    expect(md).toContain('  - flag f1 @15.1 by=R span=4..37 source=key: housing pilot covers nine thousand');
    expect(md).toContain('  - note n1 @16 by=R: vacancy?');
    expect(md).toContain('- fc1 @301.2 by=L q: Is Graz bigger than Linz?');
    expect(md).toContain('  - quick (qwen3:4b, 1200ms): Yes — Graz ~300k vs Linz ~210k.');
    // non-final segment carries the interim marker; final ones don't
    expect(md).toContain('interim ? s2:');
    expect(md).not.toContain('interim L s1:');
    // v0.3 train-fixes Part B: resolved pause shows both times; open one
    // (tEnd: null) shows an empty right side of the range.
    expect(md).toContain('## Pauses');
    expect(md).toContain('- p1 [25–42.5]');
    expect(md).toContain('- p2 [60–]');
  });

  it('v0.3 train-fixes Part B: omits the Pauses section entirely when there are none (old-file byte-identical shape)', () => {
    const noPauses: Session = { ...rich_fixture(), pauses: [] };
    const md = serialize_session(noPauses);
    expect(md).not.toContain('## Pauses');
  });
});

describe('session_md: resilient parsing of malformed input', () => {
  it('does not throw on an empty string', () => {
    expect(() => parse_session('')).not.toThrow();
    const parsed = parse_session('');
    expect(parsed.segments).toEqual([]);
    expect(parsed.flags).toEqual([]);
    expect(parsed.notes).toEqual([]);
    expect(parsed.summaries).toEqual([]);
    expect(parsed.factChecks).toEqual([]);
    expect(parsed.audioFile).toBeNull();
  });

  it('does not throw on a header-only file and defaults every section to an empty array', () => {
    const md = '# Talkweave — Untitled\nid: x\nstarted: now\nnames: L=A R=B\n';
    const parsed = parse_session(md);
    expect(parsed.title).toBe('Untitled');
    expect(parsed.segments).toEqual([]);
    expect(parsed.flags).toEqual([]);
    expect(parsed.notes).toEqual([]);
    expect(parsed.summaries).toEqual([]);
    expect(parsed.factChecks).toEqual([]);
  });

  it('drops a segment line with an unparseable time range instead of throwing', () => {
    const md = '## Transcript\n- [notanumber–also-bad] L s1: hello\n';
    const parsed = parse_session(md);
    expect(parsed.segments).toEqual([]);
  });

  it('drops a flag line with a non-numeric timestamp instead of throwing', () => {
    const md = '## Transcript\n- [1–2] L s1: hi\n  - flag f1 @notanumber by=R source=key: claim\n';
    const parsed = parse_session(md);
    expect(parsed.segments.length).toBe(1);
    expect(parsed.flags).toEqual([]);
  });

  it('nulls out an unparseable span instead of dropping the whole flag', () => {
    const md = '## Transcript\n- [1–2] L s1: hi\n  - flag f1 @5 by=R span=abc..xyz source=key: claim\n';
    const parsed = parse_session(md);
    expect(parsed.flags).toHaveLength(1);
    expect(parsed.flags[0].charStart).toBeNull();
    expect(parsed.flags[0].charEnd).toBeNull();
    expect(parsed.flags[0].claimText).toBe('claim');
  });

  it('treats a truncated flag line (missing source=) as unrecognised and drops it', () => {
    const md = '## Transcript\n- [1–2] L s1: hi\n  - flag f1 @5 by=R\n';
    const parsed = parse_session(md);
    expect(parsed.flags).toEqual([]);
  });

  it('ignores a nested flag/note line that appears with no parent segment', () => {
    const md = '## Transcript\n  - flag f1 @5 by=R source=key: orphaned-looking but still valid\n';
    const parsed = parse_session(md);
    // still a well-formed flag line: parses fine, just with segmentId null
    // because there was nothing to nest it under.
    expect(parsed.flags).toHaveLength(1);
    expect(parsed.flags[0].segmentId).toBeNull();
  });

  it('ignores an unknown top-level section entirely', () => {
    const md = '## Something Else\n- whatever this is\n- [1–2] L s1: should not appear\n';
    const parsed = parse_session(md);
    expect(parsed.segments).toEqual([]);
  });

  it('ignores unrecognised lines interspersed with valid ones', () => {
    const md = [
      '# Talkweave — T',
      'this is not a recognised header line',
      '## Transcript',
      'not a bullet at all',
      '- [1–2] L s1: real segment',
      '- this bullet matches nothing known',
      ''
    ].join('\n');
    const parsed = parse_session(md);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0].id).toBe('s1');
  });

  it('v0.3 train-fixes Part B: parses an open pause (empty tEnd) and a resolved one', () => {
    const md = '## Pauses\n- p1 [10–15.5]\n- p2 [20–]\n';
    const parsed = parse_session(md);
    expect(parsed.pauses).toEqual([
      { id: 'p1', tStart: 10, tEnd: 15.5 },
      { id: 'p2', tStart: 20, tEnd: null }
    ]);
  });

  it('v0.3 train-fixes Part B: drops a malformed pause line instead of throwing', () => {
    const md = '## Pauses\n- p1 notarange\n- p2 [also–bad–shape]\n';
    const parsed = parse_session(md);
    expect(parsed.pauses).toEqual([]);
  });

  it('drops a fact-check quick/deep line that does not match the expected shape', () => {
    const md = '## Fact-checks\n- fc1 @1 by=L q: question\n  - quick garbage\n  - deep also garbage\n';
    const parsed = parse_session(md);
    expect(parsed.factChecks).toHaveLength(1);
    expect(parsed.factChecks[0].quick).toBeNull();
    expect(parsed.factChecks[0].deep).toBeNull();
  });
});
