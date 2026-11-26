// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — server-side markdown parser for GET /api/session/:id/export
// (task-11-brief.md). server/*.mjs cannot import shared/session_md.ts (a
// real ESM import from a .mjs file into shared/*.ts resolves fine under
// tsc's NodeNext type-checking but fails at actual `node server/server.mjs`
// runtime — there is no build step compiling shared/*.ts to a real
// .js/.mjs file for Node to load; see claim.mjs's header comment for the
// same constraint already documented there).
//
// This is therefore a hand-rolled PORT of shared/session_md.ts's
// `parse_session` (the read half only — the export route never writes
// session.md, so no `serialize_session` port exists here). Kept as close to
// a line-for-line translation as JSDoc-typed plain JS allows, specifically
// so the two stay easy to eyeball-diff if shared/session_md.ts's format
// ever changes. Pinned against that module by a contract test —
// tests/session_md_parse_contract.test.ts — the same pattern
// sessions.mjs's `build_initial_markdown` uses against the same shared
// module (see that file's header comment and
// tests/session_initial_markdown.test.ts), extended here to cover every
// entity kind (segments, flags, notes, summaries, fact-checks) rather than
// just the empty-session header shape.

/**
 * @typedef {import('../../shared/model.js').Speaker} Speaker
 * @typedef {import('../../shared/model.js').Segment} Segment
 * @typedef {import('../../shared/model.js').Flag} Flag
 * @typedef {import('../../shared/model.js').Note} Note
 * @typedef {import('../../shared/model.js').Summary} Summary
 * @typedef {import('../../shared/model.js').FactCheck} FactCheck
 * @typedef {import('../../shared/model.js').Pause} Pause
 * @typedef {import('../../shared/model.js').Session} Session
 */

/** Must stay byte-identical to shared/session_md.ts's NEWLINE_ESCAPE —
 *  duplicated here for the same reason sessions.mjs duplicates it (see
 *  that file's own copy of this constant). @type {string} */
const NEWLINE_ESCAPE = '␤';

const DASH = '[-–—]';
const TITLE_RE = new RegExp(`^#\\s+Talkweave\\s+${DASH}\\s*(.*)$`);
const RANGE_RE = new RegExp(`^([\\d.]+)\\s*${DASH}\\s*([\\d.]+)$`);
// v0.3 train-fixes Part B — mirrors shared/session_md.ts's PAUSE_RANGE_RE.
const PAUSE_RANGE_RE = new RegExp(`^(\\S+)\\s+\\[([\\d.]+)\\s*${DASH}\\s*([\\d.]*)\\]$`);

/**
 * @param {string} s
 * @returns {string}
 */
function unesc(s) {
  return s.split(NEWLINE_ESCAPE).join('\n');
}

/**
 * @param {string} s
 * @returns {[string, string | null]}
 */
function split_colon(s) {
  const idx = s.indexOf(':');
  if (idx < 0) return [s, null];
  let text = s.slice(idx + 1);
  if (text.startsWith(' ')) text = text.slice(1);
  return [s.slice(0, idx), text];
}

/**
 * @param {string} content
 * @returns {Segment | null}
 */
function parse_segment_content(content) {
  const [attrsPart, textPart] = split_colon(content);
  if (textPart === null) return null;
  const m = /^\[([^\]]+)\]\s*(interim\s+)?([LR?])\s+(\S+)$/.exec(attrsPart.trim());
  if (!m) return null;
  const range = RANGE_RE.exec(m[1].trim());
  if (!range) return null;
  const tStart = Number(range[1]);
  const tEnd = Number(range[2]);
  if (!Number.isFinite(tStart) || !Number.isFinite(tEnd)) return null;
  return {
    id: m[4],
    speaker: m[3] === '?' ? null : /** @type {Speaker} */ (m[3]),
    tStart,
    tEnd,
    text: unesc(textPart),
    final: m[2] === undefined
  };
}

/**
 * @param {string} rest
 * @param {Segment | null} parentSeg
 * @returns {Flag | null}
 */
function parse_flag_content(rest, parentSeg) {
  const [attrsPart, textPart] = split_colon(rest);
  const m = /^(\S+)\s+@(\S+)\s+by=([LR])(?:\s+span=(\S+)\.\.(\S+))?\s+source=(key|dblclick|ai)$/.exec(
    attrsPart.trim()
  );
  if (!m) return null;
  const t = Number(m[2]);
  if (!Number.isFinite(t)) return null;

  /** @type {number | null} */
  let charStart = null;
  /** @type {number | null} */
  let charEnd = null;
  if (m[4] !== undefined && m[5] !== undefined) {
    const cs = Number(m[4]);
    const ce = Number(m[5]);
    if (Number.isFinite(cs) && Number.isFinite(ce)) {
      charStart = cs;
      charEnd = ce;
    }
  }

  return {
    id: m[1],
    t,
    by: /** @type {Speaker} */ (m[3]),
    segmentId: parentSeg ? parentSeg.id : null,
    claimText: textPart !== null ? unesc(textPart) : null,
    charStart,
    charEnd,
    source: /** @type {Flag['source']} */ (m[6])
  };
}

/**
 * @param {string} rest
 * @returns {Note | null}
 */
function parse_note_content(rest) {
  const [attrsPart, textPart] = split_colon(rest);
  if (textPart === null) return null;
  const m = /^(\S+)\s+@(\S+)\s+by=([LR])$/.exec(attrsPart.trim());
  if (!m) return null;
  const t = Number(m[2]);
  if (!Number.isFinite(t)) return null;
  return { id: m[1], t, by: /** @type {Speaker} */ (m[3]), text: unesc(textPart) };
}

/**
 * @param {string} content
 * @returns {Pause | null}
 */
function parse_pause_content(content) {
  const m = PAUSE_RANGE_RE.exec(content.trim());
  if (!m) return null;
  const tStart = Number(m[2]);
  if (!Number.isFinite(tStart)) return null;
  const tEnd = m[3] === '' ? null : Number(m[3]);
  if (tEnd !== null && !Number.isFinite(tEnd)) return null;
  return { id: m[1], tStart, tEnd };
}

/**
 * @param {string} content
 * @returns {Summary | null}
 */
function parse_summary_content(content) {
  const [attrsPart, textPart] = split_colon(content);
  if (textPart === null) return null;
  const m = /^\[([^\]]+)\]\s+(\S+)\s+(interval|manual)$/.exec(attrsPart.trim());
  if (!m) return null;
  const range = RANGE_RE.exec(m[1].trim());
  if (!range) return null;
  const tFrom = Number(range[1]);
  const tTo = Number(range[2]);
  if (!Number.isFinite(tFrom) || !Number.isFinite(tTo)) return null;
  return { id: m[2], tFrom, tTo, text: unesc(textPart), trigger: /** @type {Summary['trigger']} */ (m[3]) };
}

/**
 * @param {string} content
 * @returns {FactCheck | null}
 */
function parse_factcheck_content(content) {
  const [attrsPart, textPart] = split_colon(content);
  if (textPart === null) return null;
  const m = /^(\S+)\s+@(\S+)\s+by=([LR])\s+q$/.exec(attrsPart.trim());
  if (!m) return null;
  const t = Number(m[2]);
  if (!Number.isFinite(t)) return null;
  return { id: m[1], t, by: /** @type {Speaker} */ (m[3]), question: unesc(textPart), quick: null, deep: null };
}

/**
 * @param {string} content
 * @returns {FactCheck['quick']}
 */
function parse_quick_content(content) {
  const m = /^quick\s+\((.+),\s*(\d+)ms\):\s?([\s\S]*)$/.exec(content);
  if (!m) return null;
  return { model: m[1], ms: Number(m[2]), text: unesc(m[3]) };
}

/**
 * @param {string} content
 * @returns {FactCheck['deep']}
 */
function parse_deep_content(content) {
  const m =
    /^deep\s+\((.+),\s*(running|done|dismissed),\s*contradicts=(yes|no)(?:,\s*eta=(\d+)ms)?\)(?::\s?([\s\S]*))?$/.exec(
      content
    );
  if (!m) return null;
  return {
    status: /** @type {'running' | 'done' | 'dismissed'} */ (m[2]),
    text: m[5] !== undefined ? unesc(m[5]) : null,
    model: m[1],
    etaMs: m[4] !== undefined ? Number(m[4]) : null,
    contradicts: m[3] === 'yes'
  };
}

/**
 * Port of shared/session_md.ts's `parse_session` — see this file's header
 * comment. Same resilience contract: unrecognised lines/entities are
 * ignored rather than throwing, missing sections default to empty arrays.
 * @param {string} md
 * @returns {Session}
 */
export function parse_session_md(md) {
  const lines = md.split(/\r\n|\r|\n/);

  let id = '';
  let title = '';
  let startedAt = '';
  let names = { L: '', R: '' };
  /** @type {string | null} */
  let audioFile = null;

  /** @type {Segment[]} */
  const segments = [];
  /** @type {Flag[]} */
  const flags = [];
  /** @type {Note[]} */
  const notes = [];
  /** @type {Pause[]} */
  const pauses = [];
  /** @type {Summary[]} */
  const summaries = [];
  /** @type {FactCheck[]} */
  const factChecks = [];

  /** @type {'header' | 'transcript' | 'pauses' | 'summaries' | 'factchecks' | 'other'} */
  let section = 'header';
  /** @type {Segment | null} */
  let currentSegment = null;
  /** @type {FactCheck | null} */
  let currentFactCheck = null;

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const heading = /^##\s+(.*)$/.exec(trimmed);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      if (name === 'transcript') section = 'transcript';
      else if (name === 'pauses') section = 'pauses';
      else if (name === 'summaries') section = 'summaries';
      else if (name === 'fact-checks' || name === 'fact checks' || name === 'factchecks') section = 'factchecks';
      else section = 'other';
      currentSegment = null;
      currentFactCheck = null;
      continue;
    }

    if (section === 'header') {
      const titleMatch = TITLE_RE.exec(trimmed);
      if (titleMatch) {
        title = unesc(titleMatch[1].trim());
        continue;
      }
      const idMatch = /^id:\s*(.*)$/.exec(trimmed);
      if (idMatch) {
        id = idMatch[1].trim();
        continue;
      }
      const startedMatch = /^started:\s*(.*)$/.exec(trimmed);
      if (startedMatch) {
        startedAt = startedMatch[1].trim();
        continue;
      }
      const namesMatch = /^names:\s*L=(.*?)\s+R=(.*)$/.exec(trimmed);
      if (namesMatch) {
        names = { L: unesc(namesMatch[1]), R: unesc(namesMatch[2]) };
        continue;
      }
      const audioMatch = /^audio:\s*(.*)$/.exec(trimmed);
      if (audioMatch) {
        audioFile = audioMatch[1].trim() || null;
        continue;
      }
      continue;
    }

    if (section === 'other') continue;

    const bullet = /^(\s*)-\s(.*)$/.exec(line);
    if (!bullet) continue;
    const nested = bullet[1].length > 0;
    const content = bullet[2];

    if (section === 'transcript') {
      if (content.startsWith('flag ')) {
        const flag = parse_flag_content(content.slice(5), nested ? currentSegment : null);
        if (flag) flags.push(flag);
      } else if (content.startsWith('note ')) {
        const note = parse_note_content(content.slice(5));
        if (note) notes.push(note);
      } else if (content.startsWith('[')) {
        const seg = parse_segment_content(content);
        if (seg) {
          segments.push(seg);
          currentSegment = seg;
        } else {
          currentSegment = null;
        }
      }
    } else if (section === 'pauses') {
      const pause = parse_pause_content(content);
      if (pause) pauses.push(pause);
    } else if (section === 'summaries') {
      const sum = parse_summary_content(content);
      if (sum) summaries.push(sum);
    } else if (section === 'factchecks') {
      if (!nested) {
        const fc = parse_factcheck_content(content);
        if (fc) {
          factChecks.push(fc);
          currentFactCheck = fc;
        } else {
          currentFactCheck = null;
        }
      } else if (currentFactCheck) {
        if (content.startsWith('quick ')) {
          const q = parse_quick_content(content);
          if (q) currentFactCheck.quick = q;
        } else if (content.startsWith('deep ')) {
          const d = parse_deep_content(content);
          if (d) currentFactCheck.deep = d;
        }
      }
    }
  }

  return { id, startedAt, title, names, segments, flags, notes, pauses, summaries, factChecks, audioFile };
}
