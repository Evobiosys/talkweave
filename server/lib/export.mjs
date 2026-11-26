// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — GET /api/session/:id/export (task-11-brief.md): renders a
// Session into a single self-contained, black-themed HTML file. Pure
// string-building only — no disk access here (router.mjs reads session.md
// and audio.webm and hands this module already-loaded data), matching the
// project's "disk access lives only in static_files.mjs/sessions.mjs"
// separation (see router.mjs's header comment).
//
// Aesthetic mirrors the live app (global-constraints.md): pure black
// background, off-white text, amber (#ffb84d) for flag/claim highlights,
// #ff6b6b for a fact-check contradiction warning. Transcript L/R alignment
// copies transcript_view.svelte's rule exactly (L: text-align left, 25%
// right margin; R: mirrored; unattributed: centered and dimmed).

/**
 * @typedef {import('../../shared/model.js').Session} Session
 * @typedef {import('../../shared/model.js').Segment} Segment
 * @typedef {import('../../shared/model.js').Flag} Flag
 * @typedef {import('../../shared/model.js').Note} Note
 * @typedef {import('../../shared/model.js').Speaker} Speaker
 */

/** 25 MiB — task-11-brief.md's audio-embed size cap. @type {number} */
export const MAX_AUDIO_EMBED_BYTES = 25 * 1024 * 1024;

/**
 * @typedef {{ tooLarge: false; base64: string } | { tooLarge: true; bytes: number } | null} ExportAudio
 *   `null` — this session has no audio.webm at all. `{ tooLarge: true, ... }`
 *   — a file exists but is >= MAX_AUDIO_EMBED_BYTES, omitted with a note.
 *   `{ tooLarge: false, base64 }` — embed as a data: URI.
 */

/**
 * @param {string} s
 * @returns {string}
 */
function esc_html(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {number} t seconds
 * @returns {string} `mm:ss`
 */
function format_ts(t) {
  const total = Math.max(0, Math.floor(t));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * @typedef {{ charStart: number; charEnd: number }} CharRange
 */

/**
 * @param {number} rawStart
 * @param {number} rawEnd
 * @param {number} textLength
 * @returns {CharRange | null}
 */
function selection_span(rawStart, rawEnd, textLength) {
  const start = Math.max(0, Math.min(rawStart, rawEnd));
  const end = Math.min(textLength, Math.max(rawStart, rawEnd));
  if (end <= start) return null;
  return { charStart: start, charEnd: end };
}

/**
 * Port of app/src/lib/transcript_helpers.ts's `highlighted_ranges` — kept
 * here (not imported; server/*.mjs can't import app/src/**\/*.ts any more
 * than shared/*.ts, same runtime-resolution constraint documented in
 * session_md_parse.mjs's header comment) purely for VISUAL parity with the
 * live app: which char ranges of a segment's text should render amber. Not
 * contract-tested against its app-side counterpart — this only affects
 * export cosmetics, never data fidelity (unlike session_md_parse.mjs's
 * parser, which the export route's correctness genuinely depends on).
 * @param {string} segmentId
 * @param {Flag[]} flags
 * @param {number} textLength
 * @returns {CharRange[]}
 */
function highlighted_ranges(segmentId, flags, textLength) {
  const relevant = flags.filter((f) => f.segmentId === segmentId);
  if (relevant.length === 0 || textLength <= 0) return [];

  const wholeSegment = relevant.some((f) => f.charStart === null || f.charEnd === null);
  if (wholeSegment) return [{ charStart: 0, charEnd: textLength }];

  const raw = relevant
    .map((f) => selection_span(/** @type {number} */ (f.charStart), /** @type {number} */ (f.charEnd), textLength))
    .filter(/** @returns {r is CharRange} */ (r) => r !== null)
    .sort((a, b) => a.charStart - b.charStart);

  /** @type {CharRange[]} */
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.charStart <= last.charEnd) {
      last.charEnd = Math.max(last.charEnd, r.charEnd);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Renders `text`, HTML-escaped, wrapping every char range in `ranges`
 * (already merged, sorted, non-overlapping) in a `<mark class="flag-mark">`
 * — the amber claim/flag highlight.
 * @param {string} text
 * @param {CharRange[]} ranges
 * @returns {string}
 */
function render_highlighted_text(text, ranges) {
  if (ranges.length === 0) return esc_html(text);
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    out += esc_html(text.slice(cursor, r.charStart));
    out += `<mark class="flag-mark">${esc_html(text.slice(r.charStart, r.charEnd))}</mark>`;
    cursor = r.charEnd;
  }
  out += esc_html(text.slice(cursor));
  return out;
}

/**
 * Placement heuristic for notes under a segment for DISPLAY only — `Note`
 * has no `segmentId` field (shared/model.ts), so this mirrors
 * shared/session_md.ts's `segment_for_time` (same doc-comment caveat:
 * write-time/render-time placement choice only, never affects parsed
 * data). Segments are assumed already in `tStart` order (true for every
 * document this parser produces — see session_md_parse.mjs).
 * @param {Segment[]} segments
 * @param {number} t
 * @returns {Segment | null}
 */
function segment_for_time(segments, t) {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (t >= seg.tStart && t <= seg.tEnd) return seg;
  }
  /** @type {Segment | null} */
  let best = null;
  for (const seg of segments) {
    if (seg.tStart <= t) best = seg;
  }
  return best ?? segments[0];
}

/**
 * @param {Speaker | null} speaker
 * @returns {'left' | 'right' | 'center'}
 */
function alignment_for(speaker) {
  if (speaker === 'L') return 'left';
  if (speaker === 'R') return 'right';
  return 'center';
}

/**
 * @param {Session} session
 * @param {Speaker} side
 * @returns {string}
 */
function display_name(session, side) {
  const name = session.names[side].trim();
  return name || side;
}

/**
 * @param {Session} session
 * @param {Speaker | null} by
 * @returns {string}
 */
function by_name(session, by) {
  return by === null ? '?' : display_name(session, by);
}

/**
 * Renders one segment plus the flags/notes attached to it (flags via their
 * own `segmentId`; notes via `segment_for_time` — see that function's doc
 * comment) as one block of transcript HTML.
 * @param {Session} session
 * @param {Segment} seg
 * @param {Flag[]} flags
 * @param {Note[]} notesHere
 * @returns {string}
 */
function render_segment(session, seg, flags, notesHere) {
  const ranges = highlighted_ranges(seg.id, flags, seg.text.length);
  const segFlags = flags.filter((f) => f.segmentId === seg.id);
  const align = alignment_for(seg.speaker);

  let annotations = '';
  for (const f of segFlags) {
    const label = f.claimText !== null ? esc_html(f.claimText) : '(flagged, no extracted claim)';
    annotations += `<div class="annotation annotation-flag"><span class="annotation-glyph">&#9873;</span> flagged by ${esc_html(
      by_name(session, f.by)
    )} &middot; ${label}</div>`;
  }
  for (const n of notesHere) {
    annotations += `<div class="annotation annotation-note"><span class="annotation-glyph">&#9998;</span> ${esc_html(
      by_name(session, n.by)
    )}: ${esc_html(n.text)}</div>`;
  }

  return `
    <div class="segment${ranges.length > 0 ? ' flagged' : ''}" data-segment-id="${esc_html(seg.id)}">
      <div class="ts-gutter">${format_ts(seg.tStart)}</div>
      <div class="segment-col align-${align}">
        <div class="segment-body">${render_highlighted_text(seg.text, ranges)}</div>
        ${annotations ? `<div class="annotations">${annotations}</div>` : ''}
      </div>
    </div>`;
}

/**
 * v0.3 train-fixes Part B: renders one pause as a compact list item —
 * "0:42, open (never resumed)" while `tEnd` is still null, otherwise
 * "0:42, paused 0:28" (start time + real wall-clock duration; see
 * shared/model.ts's `Pause` doc comment for why `tEnd - tStart` IS that
 * duration rather than a second session-clock reading).
 * @param {import('../../shared/model.js').Pause} p
 * @returns {string}
 */
function render_pause(p) {
  const label = p.tEnd !== null ? `paused ${format_ts(p.tEnd - p.tStart)}` : 'open (never resumed)';
  return `<li class="pause-item"><span class="pause-time">${format_ts(p.tStart)}</span> <span class="pause-label">${label}</span></li>`;
}

/**
 * @param {import('../../shared/model.js').Summary} sum
 * @returns {string}
 */
function render_summary(sum) {
  return `<li class="summary-item"><span class="summary-range">${format_ts(sum.tFrom)}&ndash;${format_ts(
    sum.tTo
  )}</span> <span class="summary-trigger">${sum.trigger}</span><p>${esc_html(sum.text)}</p></li>`;
}

/**
 * @param {Session} session
 * @param {import('../../shared/model.js').FactCheck} fc
 * @returns {string}
 */
function render_factcheck(session, fc) {
  const quick = fc.quick
    ? `<div class="fc-answer fc-quick"><span class="fc-label">quick (${esc_html(fc.quick.model)}, ${fc.quick.ms}ms)</span><p>${esc_html(fc.quick.text)}</p></div>`
    : '';
  const deep = fc.deep
    ? `<div class="fc-answer fc-deep${fc.deep.contradicts ? ' contradicts' : ''}"><span class="fc-label">deep (${esc_html(
        fc.deep.model
      )}, ${fc.deep.status})${fc.deep.contradicts ? ' &mdash; contradiction flagged' : ''}</span>${
        fc.deep.text !== null ? `<p>${esc_html(fc.deep.text)}</p>` : ''
      }</div>`
    : '';
  return `<li class="fc-item"><div class="fc-question"><span class="fc-time">${format_ts(fc.t)}</span> ${esc_html(
    by_name(session, fc.by)
  )} asked: <strong>${esc_html(fc.question)}</strong></div>${quick}${deep}</li>`;
}

/**
 * @param {ExportAudio} audio
 * @returns {string}
 */
function render_audio_block(audio) {
  if (audio === null) {
    return '<p class="audio-note">No audio was recorded for this session.</p>';
  }
  if (audio.tooLarge) {
    const mb = (audio.bytes / (1024 * 1024)).toFixed(1);
    return `<p class="audio-note">Audio recording exists (${mb} MB) but exceeds the 25 MB export limit, so it was not embedded.</p>`;
  }
  return `<audio controls preload="none" src="data:audio/webm;base64,${audio.base64}"></audio>`;
}

/**
 * Renders `session` (plus optional `audio`) into a complete, self-contained
 * HTML document string — inline CSS, no external requests, minimal inline
 * JS (a "share"/re-download convenience is the app's job, not the export
 * file's; this file just displays).
 * @param {Session} session
 * @param {ExportAudio} [audio]
 * @returns {string}
 */
export function render_export_html(session, audio = null) {
  const nameL = display_name(session, 'L');
  const nameR = display_name(session, 'R');

  const notesBySegment = new Map();
  const orphanNotes = [];
  for (const n of session.notes) {
    const seg = segment_for_time(session.segments, n.t);
    if (seg) {
      const arr = notesBySegment.get(seg.id) ?? [];
      arr.push(n);
      notesBySegment.set(seg.id, arr);
    } else {
      orphanNotes.push(n);
    }
  }

  const segmentIds = new Set(session.segments.map((s) => s.id));
  const orphanFlags = session.flags.filter((f) => f.segmentId === null || !segmentIds.has(f.segmentId));

  const transcriptHtml =
    session.segments.length > 0
      ? session.segments
          .map((seg) => render_segment(session, seg, session.flags, notesBySegment.get(seg.id) ?? []))
          .join('\n')
      : '<p class="empty-hint">This session has no transcript.</p>';

  const orphanHtml =
    orphanFlags.length > 0 || orphanNotes.length > 0
      ? `<section class="orphans"><h2>Unanchored flags &amp; notes</h2>${orphanFlags
          .map(
            (f) =>
              `<div class="annotation annotation-flag">@${format_ts(f.t)} &middot; flagged by ${esc_html(
                by_name(session, f.by)
              )} &middot; ${f.claimText !== null ? esc_html(f.claimText) : '(no extracted claim)'}</div>`
          )
          .join('')}${orphanNotes
          .map(
            (n) =>
              `<div class="annotation annotation-note">@${format_ts(n.t)} &middot; ${esc_html(
                by_name(session, n.by)
              )}: ${esc_html(n.text)}</div>`
          )
          .join('')}</section>`
      : '';

  const pausesHtml =
    session.pauses.length > 0
      ? `<section class="pauses"><h2>Pauses</h2><ul>${session.pauses.map(render_pause).join('')}</ul></section>`
      : '';

  const summariesHtml =
    session.summaries.length > 0
      ? `<section class="summaries"><h2>Summaries</h2><ul>${session.summaries.map(render_summary).join('')}</ul></section>`
      : '';

  const factchecksHtml =
    session.factChecks.length > 0
      ? `<section class="factchecks"><h2>Fact-checks</h2><ul>${session.factChecks
          .map((fc) => render_factcheck(session, fc))
          .join('')}</ul></section>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc_html(session.title)} — talkweave export</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #000;
    color: #e8e8e4;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    padding: 32px 20px 80px;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 400; letter-spacing: 0.02em; margin: 0 0 4px; }
  .meta { color: #8a8a86; font-size: 13px; margin: 0 0 32px; }
  .meta .names { color: #e8e8e4; }
  h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #8a8a86; margin: 40px 0 16px; border-bottom: 1px solid #1a1a1a; padding-bottom: 8px; }
  .transcript { display: flex; flex-direction: column; gap: 18px; }
  .segment { display: flex; align-items: baseline; gap: 12px; border-left: 2px solid transparent; padding-left: 8px; margin-left: -10px; }
  .segment.flagged { border-left-color: rgba(255, 184, 77, 0.55); }
  .ts-gutter { flex: 0 0 auto; width: 36px; color: #5a5a56; font-size: 11px; font-variant-numeric: tabular-nums; }
  .segment-col { flex: 1 1 auto; min-width: 0; }
  .segment-body { font-size: 15px; word-wrap: break-word; }
  .align-left .segment-body { text-align: left; margin-right: 25%; }
  .align-right .segment-body { text-align: right; margin-left: 25%; }
  .align-center .segment-body { text-align: center; color: #8a8a86; }
  .align-left .annotations { margin-right: 25%; }
  .align-right .annotations { margin-left: 25%; text-align: right; }
  mark.flag-mark { background: none; color: #ffb84d; }
  .annotations { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
  .annotation { font-size: 12px; color: #b39a6e; }
  .annotation-note { color: #8a8a86; }
  .annotation-glyph { opacity: 0.8; }
  .empty-hint { color: #4a4a46; font-size: 13px; }
  .orphans .annotation { margin-bottom: 6px; }
  .summaries ul, .factchecks ul, .pauses ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 16px; }
  .summary-item, .fc-item { border: 1px solid #1a1a1a; border-radius: 6px; padding: 12px 16px; }
  .pause-item { color: #6a6a66; font-size: 13px; }
  .pause-time { color: #5a5a56; font-size: 11px; font-variant-numeric: tabular-nums; margin-right: 8px; }
  .summary-range, .fc-time { color: #5a5a56; font-size: 11px; font-variant-numeric: tabular-nums; }
  .summary-trigger { color: #5a5a56; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-left: 8px; }
  .summary-item p { margin: 6px 0 0; font-size: 14px; }
  .fc-question { font-size: 14px; margin-bottom: 8px; }
  .fc-answer { margin-top: 8px; padding-top: 8px; border-top: 1px solid #1a1a1a; }
  .fc-label { font-size: 11px; color: #5a5a56; text-transform: uppercase; letter-spacing: 0.03em; }
  .fc-answer p { margin: 4px 0 0; font-size: 13px; color: #cfcfca; }
  .fc-answer.contradicts { border-top-color: #ff6b6b; }
  .fc-answer.contradicts .fc-label { color: #ff6b6b; }
  .audio-section { margin-top: 40px; }
  .audio-note { color: #8a8a86; font-size: 13px; }
  audio { width: 100%; margin-top: 8px; }
  footer { margin-top: 48px; color: #4a4a46; font-size: 11px; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>${esc_html(session.title)}</h1>
  <p class="meta">talkweave conversation export &middot; <span class="names">${esc_html(nameL)} (L) &amp; ${esc_html(nameR)} (R)</span> &middot; started ${esc_html(session.startedAt)}</p>

  <section class="transcript">
    ${transcriptHtml}
  </section>
  ${orphanHtml}
  ${pausesHtml}
  ${summariesHtml}
  ${factchecksHtml}

  <section class="audio-section">
    <h2>Audio</h2>
    ${render_audio_block(audio)}
  </section>

  <footer>Exported from talkweave &middot; session ${esc_html(session.id)}</footer>
</main>
</body>
</html>
`;
}
