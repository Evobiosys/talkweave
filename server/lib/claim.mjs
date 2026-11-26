// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure claim-extraction logic for POST /api/llm/claim
// (task-9-brief.md). Kept free of any Ollama/network access (that lives in
// ollama.mjs) and free of node:http req/res concerns (those live in
// router.mjs), so every function here is directly unit-testable — same
// separation as router.mjs's own `parse_range` / the sessions.mjs disk
// layer.
//
// "The other speaker" (task-9-brief.md's wording): a flag is always
// created as a reaction to whatever was just said, so the segment nearest
// *before* `flagT` is — by construction of how flags get created
// (keymap.ts's Shift/Space handlers always target the OPPOSITE of the
// flag's own `by`) — necessarily the other person's segment. This module
// therefore never needs to know which side pressed the flag: "the other
// speaker's segment nearest before flagT" reduces to "the most recent
// FINAL segment whose tStart is before flagT," full stop.

/**
 * @typedef {import('../../shared/model.js').Segment} Segment
 */

/**
 * Review fix round 1, Important 2 ("unbounded prompt context"): the
 * MAXIMUM number of final segments `build_claim_prompt` will include,
 * nearest-to-`flagT` first. Kept as a plain local constant (not a shared
 * cross-boundary import — a real ESM import from this `.mjs` file into
 * `shared/*.ts` would resolve fine under `tsc`'s NodeNext type-checking
 * but fail at actual `node server/server.mjs` runtime, since there is no
 * build step compiling `shared/*.ts` to a real `.js`/`.mjs` file for Node
 * to load) mirrored by `app/src/lib/ai_pipeline.ts`'s own
 * `CLAIM_CONTEXT_WINDOW_SEGMENTS` — the client windows what it *sends*
 * down to this same count before this defensive server-side truncation
 * even runs; keep both in sync if this number ever changes.
 */
export const CLAIM_CONTEXT_WINDOW_SEGMENTS = 12;

/**
 * The most recent (largest `tStart`) FINAL segment starting strictly
 * before `flagT`. Doesn't assume `segments` is already sorted (defensive,
 * matching transcript_helpers.ts's `highlighted_ranges` precedent) —
 * scans the whole array rather than trusting array order. `undefined` when
 * no segment qualifies (task-9-brief.md's "no other-speaker segment" edge
 * case).
 * @param {Segment[]} segments
 * @param {number} flagT
 * @returns {Segment | undefined}
 */
export function most_recent_final_segment_before(segments, flagT) {
  /** @type {Segment | undefined} */
  let best;
  for (const seg of segments) {
    if (!seg.final) continue;
    if (seg.tStart >= flagT) continue;
    if (!best || seg.tStart > best.tStart) best = seg;
  }
  return best;
}

/**
 * Builds the prompt sent to the claim model: the conversation so far (up
 * to `flagT`, chronological, capped to the most recent
 * `CLAIM_CONTEXT_WINDOW_SEGMENTS` — review Important 2: the client already
 * windows what it sends via `ai_pipeline.ts`'s `window_claim_context`, but
 * this is a defensive second cap here too, so a future/other client that
 * forgets to window still can't blow up the prompt size), an instruction
 * to return ONLY the exact verbatim sentence/clause copied from that
 * transcript, and — when given — the flagging person's free-text
 * `principles` (settings_store_core.ts's per-person guidance) appended as
 * extra steering.
 * @param {Segment[]} context
 * @param {number} flagT
 * @param {string} [principles]
 * @returns {string}
 */
export function build_claim_prompt(context, flagT, principles) {
  const prior = context
    .filter((s) => s.final && s.tStart < flagT)
    .slice()
    .sort((a, b) => a.tStart - b.tStart)
    .slice(-CLAIM_CONTEXT_WINDOW_SEGMENTS);
  const transcript = prior.map((s) => `${s.speaker ?? '?'}: ${s.text}`).join('\n');
  const guidance = principles && principles.trim() ? `\nAdditional guidance: ${principles.trim()}` : '';

  return [
    'You are extracting a verbatim claim from a live conversation transcript.',
    'Below is the transcript so far. Return ONLY the exact sentence or clause the OTHER speaker said, copied',
    'word-for-word from the transcript — no paraphrasing, no surrounding quotes, no commentary, nothing else.',
    '',
    'Transcript:',
    transcript,
    guidance,
    '',
    'Verbatim claim:'
  ].join('\n');
}

/**
 * Strips one layer of straight/curly quote wrapping the model sometimes
 * adds despite being told not to (`"like this"`, `'like this'`,
 * `“like this”`), so the substring check right below isn't defeated by a
 * quote character the transcript itself doesn't contain. Only strips a
 * MATCHING pair (both ends), never a lone leading or trailing quote — a
 * real verbatim claim that itself starts or ends with a quotation mark
 * must not be mangled.
 * @param {string} text
 * @returns {string}
 */
export function strip_wrapping_quotes(text) {
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’']
  ];
  for (const [open, close] of pairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

/**
 * Locates `claimText` (already trimmed/de-quoted) as an exact substring of
 * one of `context`'s segments, searching segments NEAREST-BEFORE `flagT`
 * first — task-9-brief.md's edge case "claim appearing twice → nearest-
 * before-flagT occurrence": if the same phrase happens to appear in more
 * than one segment, the one closer to the flag wins, since that's the one
 * an extraction "nearest before flagT" actually meant. `null` when the
 * text isn't found verbatim in any eligible segment (the caller falls back
 * to `sentence_fallback` below).
 * @param {Segment[]} segments
 * @param {string} claimText
 * @param {number} flagT
 * @returns {{ segmentId: string; charStart: number; charEnd: number } | null}
 */
export function locate_claim(segments, claimText, flagT) {
  if (!claimText) return null;
  const eligible = segments
    .filter((s) => s.final && s.tStart < flagT)
    .slice()
    .sort((a, b) => b.tStart - a.tStart); // nearest-before-flagT first

  for (const seg of eligible) {
    const idx = seg.text.indexOf(claimText);
    if (idx !== -1) {
      return { segmentId: seg.id, charStart: idx, charEnd: idx + claimText.length };
    }
  }
  return null;
}

/**
 * Splits `text` into "full" sentences (a run of non-terminal characters
 * followed by one or more `.`/`!`/`?`), each with its own char offset
 * range within `text`. A trailing run with no terminal punctuation at all
 * (an in-progress/unpunctuated utterance) is NOT included — task-9-
 * brief.md asks for the last FULL sentence specifically.
 * @param {string} text
 * @returns {{ text: string; start: number; end: number }[]}
 */
export function full_sentences(text) {
  /** @type {{ text: string; start: number; end: number }[]} */
  const out = [];
  const re = /[^.!?]+[.!?]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index + leading;
    out.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return out;
}

/**
 * The fallback claim per task-9-brief.md: "last full sentence of the most
 * recent other-speaker segment." Falls back further, to the segment's
 * entire trimmed text, when that segment has no terminal punctuation at
 * all (an in-progress utterance with no `.`/`!`/`?` anywhere) — returning
 * nothing at all in that case would silently leave a flag's whole-segment
 * highlight un-upgraded for a segment that's otherwise a perfectly good
 * fallback candidate, which is a worse outcome than "the whole segment
 * text, unpunctuated." `null` only when there's no eligible segment at all
 * (task-9-brief.md's "no other-speaker segment" edge case) or that
 * segment's text is empty/whitespace-only.
 * @param {Segment[]} segments
 * @param {number} flagT
 * @returns {{ text: string; segmentId: string; charStart: number; charEnd: number } | null}
 */
export function sentence_fallback(segments, flagT) {
  const target = most_recent_final_segment_before(segments, flagT);
  if (!target) return null;

  const sentences = full_sentences(target.text);
  if (sentences.length > 0) {
    const last = sentences[sentences.length - 1];
    return { text: last.text, segmentId: target.id, charStart: last.start, charEnd: last.end };
  }

  const trimmed = target.text.trim();
  if (!trimmed) return null;
  const start = target.text.indexOf(trimmed);
  return { text: trimmed, segmentId: target.id, charStart: start, charEnd: start + trimmed.length };
}
