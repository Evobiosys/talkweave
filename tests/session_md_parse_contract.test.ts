// SPDX-License-Identifier: AGPL-3.0-or-later

// Contract test between server/lib/session_md_parse.mjs's hand-rolled
// `parse_session_md` (server/*.mjs can't import shared/*.ts — see that
// module's header comment) and shared/session_md.ts's own
// `parse_session`/`serialize_session`. Nothing else guards these two
// independently-written parsers against drifting apart, so this pins them
// together explicitly across every entity kind the export route renders,
// mirroring the pattern tests/session_initial_markdown.test.ts already
// established for sessions.mjs's narrower `build_initial_markdown`.
import { describe, it, expect } from 'vitest';
import { parse_session_md } from '../server/lib/session_md_parse.mjs';
import { parse_session, serialize_session } from '../shared/session_md';
import type { Session } from '../shared/model';

const FULL_SESSION: Session = {
  id: '20260822-101500',
  startedAt: '2026-08-22T10:15:00.000Z',
  title: 'Full fixture session',
  names: { L: 'Jakob', R: 'Alex' },
  audioFile: 'audio.webm',
  segments: [
    { id: 's1', speaker: 'L', tStart: 0, tEnd: 5, text: 'Styria has about eighteen thousand vacant units.', final: true },
    { id: 's2', speaker: 'R', tStart: 5, tEnd: 8, text: 'That sounds made up.', final: true },
    { id: 's3', speaker: null, tStart: 8, tEnd: 9, text: '(crosstalk)', final: true },
    { id: 's4', speaker: 'L', tStart: 9, tEnd: 12, text: 'still going', final: false }
  ],
  flags: [
    // whole-segment flag (no span), AI-extracted claim text
    { id: 'f1', t: 6, by: 'R', segmentId: 's1', claimText: 'eighteen thousand vacant units', charStart: null, charEnd: null, source: 'ai' },
    // precise-span dblclick flag
    { id: 'f2', t: 7, by: 'L', segmentId: 's2', claimText: 'made up', charStart: 12, charEnd: 19, source: 'dblclick' },
    // orphan flag (no segment)
    { id: 'f3', t: 20, by: 'L', segmentId: null, claimText: null, charStart: null, charEnd: null, source: 'key' }
  ],
  notes: [{ id: 'n1', t: 6.5, by: 'L', text: 'double-check this stat' }],
  // v0.3 train-fixes Part B
  pauses: [
    { id: 'p1', tStart: 3, tEnd: 4.5 },
    { id: 'p2', tStart: 10, tEnd: null }
  ],
  summaries: [
    { id: 'sm1', tFrom: 0, tTo: 9, text: 'Discussed vacancy numbers.', trigger: 'interval' },
    { id: 'sm2', tFrom: 9, tTo: 12, text: 'Manual recap.', trigger: 'manual' }
  ],
  factChecks: [
    {
      id: 'fc1',
      t: 6.5,
      by: 'R',
      question: 'Is the vacancy number accurate?',
      quick: { text: 'Plausible per regional housing surveys.', model: 'qwen3:4b', ms: 850 },
      deep: { status: 'done', text: 'Contradicts the cited 2022 report.', model: 'qwen3.6-27b-iq4:latest', etaMs: 42000, contradicts: true }
    }
  ]
};

describe('parse_session_md vs shared/session_md.ts', () => {
  const md = serialize_session(FULL_SESSION);
  const viaShared = parse_session(md);
  const viaServer = parse_session_md(md);

  it('both parsers agree on the full session, field by field', () => {
    expect(viaServer).toEqual(viaShared);
  });

  it('round-trips the header fields', () => {
    expect(viaServer.id).toBe(FULL_SESSION.id);
    expect(viaServer.startedAt).toBe(FULL_SESSION.startedAt);
    expect(viaServer.title).toBe(FULL_SESSION.title);
    expect(viaServer.names).toEqual(FULL_SESSION.names);
    expect(viaServer.audioFile).toBe(FULL_SESSION.audioFile);
  });

  it('round-trips every segment, including a null-speaker and an interim one', () => {
    expect(viaServer.segments).toEqual(FULL_SESSION.segments);
  });

  it('round-trips flags: whole-segment, precise-span, and orphan', () => {
    expect(viaServer.flags).toEqual(FULL_SESSION.flags);
  });

  it('round-trips notes and summaries (both triggers) and a fact-check with quick+deep+contradiction', () => {
    expect(viaServer.notes).toEqual(FULL_SESSION.notes);
    expect(viaServer.summaries).toEqual(FULL_SESSION.summaries);
    expect(viaServer.factChecks).toEqual(FULL_SESSION.factChecks);
  });

  it('v0.3 train-fixes Part B: round-trips pauses, including a still-open one (tEnd: null)', () => {
    expect(viaServer.pauses).toEqual(FULL_SESSION.pauses);
  });

  it('agrees with the shared parser on a session with no audio and empty sections', () => {
    const empty: Session = { ...FULL_SESSION, audioFile: null, segments: [], flags: [], notes: [], pauses: [], summaries: [], factChecks: [] };
    const emptyMd = serialize_session(empty);
    expect(parse_session_md(emptyMd)).toEqual(parse_session(emptyMd));
  });

  it('agrees with the shared parser on escaped embedded newlines in free text', () => {
    const withNewlines: Session = {
      ...FULL_SESSION,
      title: 'line one\nline two',
      names: { L: 'A\nB', R: 'C' }
    };
    const nlMd = serialize_session(withNewlines);
    expect(parse_session_md(nlMd)).toEqual(parse_session(nlMd));
  });
});
