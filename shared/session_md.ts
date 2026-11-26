// SPDX-License-Identifier: AGPL-3.0-or-later

// shared/session_md.ts
//
// Markdown session format: `serialize_session` / `parse_session`. The
// markdown file IS the store — this is not an export format, it's the
// primary persistence format (see global-constraints.md). The parser is
// deliberately resilient: unrecognised lines are ignored, unrecognised or
// malformed entities are dropped rather than throwing, and missing
// sections default to empty arrays.
//
// Format (see task-2-brief.md for the canonical example):
//
//   # Talkweave — <title>
//   id: <session id>
//   started: <ISO timestamp>
//   names: L=<name> R=<name>
//   audio: <filename>                    (omitted when audioFile is null)
//
//   ## Transcript
//   - [<tStart>–<tEnd>] [interim ]<L|R|?> <id>: <text>
//     - flag <id> @<t> by=<L|R> [span=<charStart>..<charEnd>] source=<key|dblclick|ai>[: <claimText>]
//     - note <id> @<t> by=<L|R>: <text>
//
//   ## Summaries
//   - [<tFrom>–<tTo>] <id> <interval|manual>: <text>
//
//   ## Fact-checks
//   - <id> @<t> by=<L|R> q: <question>
//     - quick (<model>, <ms>ms): <text>
//     - deep (<model>, <running|done|dismissed>, contradicts=<yes|no>[, eta=<etaMs>ms])[: <text>]
//
// Two deliberate additions beyond the brief's illustrative sample, both
// required so every field in shared/model.ts round-trips:
//   - `id:` header line — the sample never shows Session.id anywhere, but
//     parse_session must return one, so it has to live somewhere in the text.
//   - `interim` token on a segment line, emitted only when `final === false`
//     (so the common, finalized case stays byte-identical to the sample);
//     `sm<n>` id token on summary lines, since Summary.id is likewise absent
//     from the sample; `eta=<ms>ms` on the deep line, emitted only when
//     `etaMs !== null`.
//
// Invariant assumed by the serializer/parser pair (not enforced): entries
// within `Session.flags` and `Session.notes` are already in "document
// order" — i.e. flags/notes attributed to an earlier segment precede those
// attributed to a later one. This holds naturally for an append-only live
// transcript (flags/notes are created in real time, in step with segments)
// and is what Task 3's store is expected to maintain. If it doesn't hold,
// serialize_session groups entries by segment and the resulting document
// order will differ from the original array order, so
// parse_session(serialize_session(s)) may reorder `flags`/`notes` relative
// to `s` even though every individual entity round-trips correctly.

import type { FactCheck, Flag, Note, Pause, Segment, Session, Speaker, Summary } from './model';

/** Sentinel used to escape literal newlines inside free-text fields. */
export const NEWLINE_ESCAPE = '␤'; // '␤'

const DASH = '[-–—]'; // '-', '–', or '—' — accepted on parse; '–'/'—' emitted on serialize
const TITLE_RE = new RegExp(`^#\\s+Talkweave\\s+${DASH}\\s*(.*)$`);

function esc(s: string): string {
  return s.split('\n').join(NEWLINE_ESCAPE);
}

function unesc(s: string): string {
  return s.split(NEWLINE_ESCAPE).join('\n');
}

function fmt(n: number): string {
  return String(n);
}

/**
 * Splits `s` at the first literal ':'. Returns [before, null] when there is
 * no colon (i.e. the field is absent), otherwise [before, after] with at
 * most one leading space stripped from `after`. None of the attribute
 * tokens this format uses (ids, `@t`, `by=`, `span=`, `source=`, `q`,
 * range brackets, trigger words) ever contain a literal ':', so the first
 * colon in a line unambiguously marks the start of its free-text tail —
 * this holds even if that tail is empty or itself contains colons.
 */
function split_colon(s: string): [string, string | null] {
  const idx = s.indexOf(':');
  if (idx < 0) return [s, null];
  let text = s.slice(idx + 1);
  if (text.startsWith(' ')) text = text.slice(1);
  return [s.slice(0, idx), text];
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function serialize_session(s: Session): string {
  const lines: string[] = [];

  lines.push(`# Talkweave — ${esc(s.title)}`);
  lines.push(`id: ${s.id}`);
  lines.push(`started: ${s.startedAt}`);
  lines.push(`names: L=${esc(s.names.L)} R=${esc(s.names.R)}`);
  if (s.audioFile !== null) lines.push(`audio: ${s.audioFile}`);
  lines.push('');

  lines.push('## Transcript');
  lines.push(...transcript_lines(s));
  lines.push('');

  // v0.3 train-fixes Part B: emitted ONLY when non-empty, so a
  // pre-v0.3 file with no pauses re-serializes byte-identical to what it
  // was — the "old files parse unchanged" contract session_md.ts's header
  // comment describes for every other unknown/missing section.
  if (s.pauses.length > 0) {
    lines.push('## Pauses');
    for (const p of s.pauses) {
      lines.push(`- ${pause_content(p)}`);
    }
    lines.push('');
  }

  lines.push('## Summaries');
  for (const sum of s.summaries) {
    lines.push(`- ${summary_content(sum)}`);
  }
  lines.push('');

  lines.push('## Fact-checks');
  for (const fc of s.factChecks) {
    lines.push(`- ${factcheck_content(fc)}`);
    if (fc.quick) lines.push(`  - ${quick_content(fc.quick)}`);
    if (fc.deep) lines.push(`  - ${deep_content(fc.deep)}`);
  }

  return lines.join('\n') + '\n';
}

function transcript_lines(s: Session): string[] {
  const out: string[] = [];
  const segById = new Map(s.segments.map((seg) => [seg.id, seg]));

  const flagsBySeg = new Map<string, Flag[]>();
  const orphanFlags: Flag[] = [];
  for (const f of s.flags) {
    if (f.segmentId !== null && segById.has(f.segmentId)) {
      const arr = flagsBySeg.get(f.segmentId);
      if (arr) arr.push(f);
      else flagsBySeg.set(f.segmentId, [f]);
    } else {
      orphanFlags.push(f);
    }
  }

  const notesBySeg = new Map<string, Note[]>();
  const orphanNotes: Note[] = [];
  for (const n of s.notes) {
    const seg = segment_for_time(s.segments, n.t);
    if (seg) {
      const arr = notesBySeg.get(seg.id);
      if (arr) arr.push(n);
      else notesBySeg.set(seg.id, [n]);
    } else {
      orphanNotes.push(n);
    }
  }

  for (const seg of s.segments) {
    out.push(`- ${segment_content(seg)}`);
    for (const f of flagsBySeg.get(seg.id) ?? []) out.push(`  - ${flag_content(f)}`);
    for (const n of notesBySeg.get(seg.id) ?? []) out.push(`  - ${note_content(n)}`);
  }
  for (const f of orphanFlags) out.push(`- ${flag_content(f)}`);
  for (const n of orphanNotes) out.push(`- ${note_content(n)}`);

  return out;
}

/**
 * Assigns a note (which carries no segmentId of its own) to the segment it
 * should be nested under for display: the segment whose [tStart, tEnd]
 * contains it, else the latest segment starting at or before it, else the
 * first segment, else null when there are no segments at all. This is a
 * write-time placement choice only — Note has no field that records it, so
 * it does not affect round-trip correctness.
 */
function segment_for_time(segments: Segment[], t: number): Segment | null {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (t >= seg.tStart && t <= seg.tEnd) return seg;
  }
  let best: Segment | null = null;
  for (const seg of segments) {
    if (seg.tStart <= t) best = seg;
  }
  return best ?? segments[0];
}

function segment_content(seg: Segment): string {
  const speaker = seg.speaker === null ? '?' : seg.speaker;
  const interim = seg.final ? '' : 'interim ';
  return `[${fmt(seg.tStart)}–${fmt(seg.tEnd)}] ${interim}${speaker} ${seg.id}: ${esc(seg.text)}`;
}

function flag_content(f: Flag): string {
  let out = `flag ${f.id} @${fmt(f.t)} by=${f.by}`;
  if (f.charStart !== null && f.charEnd !== null) {
    out += ` span=${fmt(f.charStart)}..${fmt(f.charEnd)}`;
  }
  out += ` source=${f.source}`;
  if (f.claimText !== null) out += `: ${esc(f.claimText)}`;
  return out;
}

function note_content(n: Note): string {
  return `note ${n.id} @${fmt(n.t)} by=${n.by}: ${esc(n.text)}`;
}

function summary_content(sum: Summary): string {
  return `[${fmt(sum.tFrom)}–${fmt(sum.tTo)}] ${sum.id} ${sum.trigger}: ${esc(sum.text)}`;
}

function factcheck_content(fc: FactCheck): string {
  return `${fc.id} @${fmt(fc.t)} by=${fc.by} q: ${esc(fc.question)}`;
}

function quick_content(q: NonNullable<FactCheck['quick']>): string {
  return `quick (${q.model}, ${fmt(q.ms)}ms): ${esc(q.text)}`;
}

function pause_content(p: Pause): string {
  const end = p.tEnd !== null ? fmt(p.tEnd) : '';
  return `${p.id} [${fmt(p.tStart)}–${end}]`;
}

function deep_content(d: NonNullable<FactCheck['deep']>): string {
  const parts = [d.model, d.status, `contradicts=${d.contradicts ? 'yes' : 'no'}`];
  if (d.etaMs !== null) parts.push(`eta=${fmt(d.etaMs)}ms`);
  const head = `deep (${parts.join(', ')})`;
  return d.text !== null ? `${head}: ${esc(d.text)}` : head;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

type Section = 'header' | 'transcript' | 'pauses' | 'summaries' | 'factchecks' | 'other';

export function parse_session(md: string): Session {
  const lines = md.split(/\r\n|\r|\n/);

  let id = '';
  let title = '';
  let startedAt = '';
  let names = { L: '', R: '' };
  let audioFile: string | null = null;

  const segments: Segment[] = [];
  const flags: Flag[] = [];
  const notes: Note[] = [];
  const pauses: Pause[] = [];
  const summaries: Summary[] = [];
  const factChecks: FactCheck[] = [];

  let section: Section = 'header';
  let currentSegment: Segment | null = null;
  let currentFactCheck: FactCheck | null = null;

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
      continue; // unknown header line: ignored
    }

    if (section === 'other') continue;

    const bullet = /^(\s*)-\s(.*)$/.exec(line);
    if (!bullet) continue; // unknown line: ignored
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
      // else: unrecognised bullet content, ignored
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

const RANGE_RE = new RegExp(`^([\\d.]+)\\s*${DASH}\\s*([\\d.]+)$`);
// Same shape as RANGE_RE but the right side may be empty ("t0–") — an open
// pause (tEnd still null) has no end time to show yet.
const PAUSE_RANGE_RE = new RegExp(`^(\\S+)\\s+\\[([\\d.]+)\\s*${DASH}\\s*([\\d.]*)\\]$`);

function parse_pause_content(content: string): Pause | null {
  const m = PAUSE_RANGE_RE.exec(content.trim());
  if (!m) return null;
  const tStart = Number(m[2]);
  if (!Number.isFinite(tStart)) return null;
  const tEnd = m[3] === '' ? null : Number(m[3]);
  if (tEnd !== null && !Number.isFinite(tEnd)) return null;
  return { id: m[1], tStart, tEnd };
}

function parse_segment_content(content: string): Segment | null {
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
    speaker: m[3] === '?' ? null : (m[3] as Speaker),
    tStart,
    tEnd,
    text: unesc(textPart),
    final: m[2] === undefined
  };
}

function parse_flag_content(rest: string, parentSeg: Segment | null): Flag | null {
  const [attrsPart, textPart] = split_colon(rest);
  const m = /^(\S+)\s+@(\S+)\s+by=([LR])(?:\s+span=(\S+)\.\.(\S+))?\s+source=(key|dblclick|ai)$/.exec(
    attrsPart.trim()
  );
  if (!m) return null;
  const t = Number(m[2]);
  if (!Number.isFinite(t)) return null;

  let charStart: number | null = null;
  let charEnd: number | null = null;
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
    by: m[3] as Speaker,
    segmentId: parentSeg ? parentSeg.id : null,
    claimText: textPart !== null ? unesc(textPart) : null,
    charStart,
    charEnd,
    source: m[6] as Flag['source']
  };
}

function parse_note_content(rest: string): Note | null {
  const [attrsPart, textPart] = split_colon(rest);
  if (textPart === null) return null;
  const m = /^(\S+)\s+@(\S+)\s+by=([LR])$/.exec(attrsPart.trim());
  if (!m) return null;
  const t = Number(m[2]);
  if (!Number.isFinite(t)) return null;
  return { id: m[1], t, by: m[3] as Speaker, text: unesc(textPart) };
}

function parse_summary_content(content: string): Summary | null {
  const [attrsPart, textPart] = split_colon(content);
  if (textPart === null) return null;
  const m = /^\[([^\]]+)\]\s+(\S+)\s+(interval|manual)$/.exec(attrsPart.trim());
  if (!m) return null;
  const range = RANGE_RE.exec(m[1].trim());
  if (!range) return null;
  const tFrom = Number(range[1]);
  const tTo = Number(range[2]);
  if (!Number.isFinite(tFrom) || !Number.isFinite(tTo)) return null;
  return { id: m[2], tFrom, tTo, text: unesc(textPart), trigger: m[3] as Summary['trigger'] };
}

function parse_factcheck_content(content: string): FactCheck | null {
  const [attrsPart, textPart] = split_colon(content);
  if (textPart === null) return null;
  const m = /^(\S+)\s+@(\S+)\s+by=([LR])\s+q$/.exec(attrsPart.trim());
  if (!m) return null;
  const t = Number(m[2]);
  if (!Number.isFinite(t)) return null;
  return { id: m[1], t, by: m[3] as Speaker, question: unesc(textPart), quick: null, deep: null };
}

function parse_quick_content(content: string): FactCheck['quick'] {
  const m = /^quick\s+\((.+),\s*(\d+)ms\):\s?([\s\S]*)$/.exec(content);
  if (!m) return null;
  return { model: m[1], ms: Number(m[2]), text: unesc(m[3]) };
}

function parse_deep_content(content: string): FactCheck['deep'] {
  const m =
    /^deep\s+\((.+),\s*(running|done|dismissed),\s*contradicts=(yes|no)(?:,\s*eta=(\d+)ms)?\)(?::\s?([\s\S]*))?$/.exec(
      content
    );
  if (!m) return null;
  return {
    status: m[2] as 'running' | 'done' | 'dismissed',
    text: m[5] !== undefined ? unesc(m[5]) : null,
    model: m[1],
    etaMs: m[4] !== undefined ? Number(m[4]) : null,
    contradicts: m[3] === 'yes'
  };
}
