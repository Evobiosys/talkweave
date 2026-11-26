// SPDX-License-Identifier: AGPL-3.0-or-later

// Contract test between server/lib/sessions.mjs's hand-rolled
// build_initial_markdown (server/*.mjs can't import shared/*.ts) and
// shared/session_md.ts's serialize_session/parse_session. Nothing else
// guards these two independently-written implementations against drifting
// apart, so this pins them together explicitly.
import { describe, it, expect } from 'vitest';
import { build_initial_markdown } from '../server/lib/sessions.mjs';
import { parse_session, serialize_session } from '../shared/session_md';

describe('build_initial_markdown vs shared/session_md.ts', () => {
  const fields = {
    id: '20260818-153000',
    startedAt: '2026-08-18T15:30:00.000Z',
    title: 'A brand new conversation',
    names: { L: 'Alice', R: 'Bob' }
  };

  it('round-trips through parse_session with every header field intact', () => {
    const md = build_initial_markdown(fields);
    const parsed = parse_session(md);

    expect(parsed.id).toBe(fields.id);
    expect(parsed.startedAt).toBe(fields.startedAt);
    expect(parsed.title).toBe(fields.title);
    expect(parsed.names).toEqual(fields.names);
    expect(parsed.segments).toEqual([]);
    expect(parsed.flags).toEqual([]);
    expect(parsed.notes).toEqual([]);
    expect(parsed.summaries).toEqual([]);
    expect(parsed.factChecks).toEqual([]);
    expect(parsed.audioFile).toBeNull();
  });

  it('re-serializing the parsed result reproduces the exact same markdown byte-for-byte', () => {
    const md = build_initial_markdown(fields);
    const parsed = parse_session(md);

    expect(serialize_session(parsed)).toBe(md);
  });

  it('handles empty names without breaking the round-trip', () => {
    const md = build_initial_markdown({ ...fields, names: { L: '', R: '' } });
    const parsed = parse_session(md);

    expect(parsed.names).toEqual({ L: '', R: '' });
    expect(serialize_session(parsed)).toBe(md);
  });

  // Fix round 1 finding: build_initial_markdown must escape embedded
  // newlines in title/names exactly like serialize_session's esc() does
  // (\n -> '␤'), or a multi-line title/name silently corrupts (parse_session
  // reads only the first line as the value, truncating the rest) on a
  // reachable input: POST /api/session's JSON body passes title/names
  // straight through to create_session -> build_initial_markdown.
  it('escapes an embedded newline in the title so it survives the round-trip intact', () => {
    const md = build_initial_markdown({ ...fields, title: 'line1\nline2' });
    const parsed = parse_session(md);

    expect(parsed.title).toBe('line1\nline2');
    expect(serialize_session(parsed)).toBe(md);
  });

  it('escapes an embedded newline in names.L/names.R so they survive the round-trip intact', () => {
    const md = build_initial_markdown({ ...fields, names: { L: 'A\nnother', R: 'B\nob' } });
    const parsed = parse_session(md);

    expect(parsed.names).toEqual({ L: 'A\nnother', R: 'B\nob' });
    expect(serialize_session(parsed)).toBe(md);
  });

  it('produces the same line count as the well-formed fixture (no extra lines sneak in from an unescaped newline)', () => {
    const baseline = build_initial_markdown(fields);
    const withNewlines = build_initial_markdown({ ...fields, title: 'a\nb', names: { L: 'c\nd', R: 'e\nf' } });

    expect(withNewlines.split('\n').length).toBe(baseline.split('\n').length);
    expect(withNewlines).toContain('␤');
  });
});
