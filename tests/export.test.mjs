// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — server/lib/export.mjs unit tests (task-11-brief.md: "export
// round-trip test: export HTML contains flagged claim text + both names").
import { describe, it, expect } from 'vitest';
import { render_export_html, MAX_AUDIO_EMBED_BYTES } from '../server/lib/export.mjs';

function base_session(overrides = {}) {
  return {
    id: '20260822-101500',
    startedAt: '2026-08-22T10:15:00.000Z',
    title: 'Housing pitch',
    names: { L: 'Jakob', R: 'Alex' },
    audioFile: null,
    segments: [
      { id: 's1', speaker: 'L', tStart: 0, tEnd: 5, text: 'Styria has about eighteen thousand vacant units.', final: true },
      { id: 's2', speaker: 'R', tStart: 5, tEnd: 8, text: 'That sounds made up.', final: true }
    ],
    flags: [],
    notes: [],
    summaries: [],
    factChecks: [],
    pauses: [],
    ...overrides
  };
}

describe('render_export_html', () => {
  it('contains both L and R names', () => {
    const html = render_export_html(base_session());
    expect(html).toContain('Jakob');
    expect(html).toContain('Alex');
  });

  it('contains a flagged claim text, highlighted, for a whole-segment flag', () => {
    const session = base_session({
      flags: [{ id: 'f1', t: 6, by: 'R', segmentId: 's1', claimText: 'eighteen thousand vacant units', charStart: null, charEnd: null, source: 'ai' }]
    });
    const html = render_export_html(session);
    // whole segment highlighted -> entire segment text wrapped in the amber mark
    expect(html).toContain('<mark class="flag-mark">Styria has about eighteen thousand vacant units.</mark>');
    expect(html).toContain('class="segment flagged"');
    // the AI-extracted claim text itself is also surfaced as an annotation
    expect(html).toContain('eighteen thousand vacant units');
  });

  it('highlights only the precise span for a dblclick flag', () => {
    const session = base_session({
      flags: [{ id: 'f2', t: 7, by: 'L', segmentId: 's2', claimText: 'made up', charStart: 12, charEnd: 19, source: 'dblclick' }]
    });
    const html = render_export_html(session);
    expect(html).toContain('<mark class="flag-mark">made up</mark>');
    // the rest of the segment text is present but not inside the mark
    expect(html).toContain('That sounds ');
  });

  it('escapes HTML-significant characters in transcript text and names', () => {
    const session = base_session({
      names: { L: '<Jakob>', R: 'Alex & Co' },
      segments: [{ id: 's1', speaker: 'L', tStart: 0, tEnd: 1, text: '<script>alert(1)</script>', final: true }]
    });
    const html = render_export_html(session);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;Jakob&gt;');
    expect(html).toContain('Alex &amp; Co');
  });

  it('renders notes and summaries and fact-checks, including a contradiction', () => {
    const session = base_session({
      notes: [{ id: 'n1', t: 6.5, by: 'L', text: 'double-check this stat' }],
      summaries: [{ id: 'sm1', tFrom: 0, tTo: 8, text: 'Discussed vacancy numbers.', trigger: 'interval' }],
      factChecks: [
        {
          id: 'fc1',
          t: 6.5,
          by: 'R',
          question: 'Is the vacancy number accurate?',
          quick: { text: 'Plausible.', model: 'qwen3:4b', ms: 850 },
          deep: { status: 'done', text: 'Contradicts a cited report.', model: 'qwen3.6-27b-iq4:latest', etaMs: 42000, contradicts: true }
        }
      ]
    });
    const html = render_export_html(session);
    expect(html).toContain('double-check this stat');
    expect(html).toContain('Discussed vacancy numbers.');
    expect(html).toContain('Is the vacancy number accurate?');
    expect(html).toContain('Plausible.');
    expect(html).toContain('Contradicts a cited report.');
    expect(html).toContain('contradicts');
  });

  it('v0.3 train-fixes Part B: renders a resolved pause with its real duration and an open one as "never resumed"', () => {
    const session = base_session({
      pauses: [
        { id: 'p1', tStart: 42, tEnd: 70 },
        { id: 'p2', tStart: 100, tEnd: null }
      ]
    });
    const html = render_export_html(session);
    expect(html).toContain('paused 0:28');
    expect(html).toContain('never resumed');
  });

  it('omits the Pauses section entirely when there are none', () => {
    const html = render_export_html(base_session());
    expect(html).not.toContain('>Pauses<');
  });

  it('shows a "no audio" note when the session has none', () => {
    const html = render_export_html(base_session(), null);
    expect(html).toContain('No audio was recorded');
    expect(html).not.toContain('<audio');
  });

  it('embeds audio as a base64 data URI when small enough', () => {
    const html = render_export_html(base_session({ audioFile: 'audio.webm' }), { tooLarge: false, base64: 'ZmFrZQ==' });
    expect(html).toContain('<audio controls preload="none" src="data:audio/webm;base64,ZmFrZQ==">');
  });

  it('omits audio with a size note when it exceeds the embed cap', () => {
    const html = render_export_html(base_session({ audioFile: 'audio.webm' }), { tooLarge: true, bytes: MAX_AUDIO_EMBED_BYTES + 1 });
    expect(html).not.toContain('<audio');
    expect(html).toContain('exceeds the 25 MB export limit');
  });

  it('is a self-contained document with no external requests', () => {
    const html = render_export_html(base_session());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toMatch(/^<!doctype html>/);
  });
});
