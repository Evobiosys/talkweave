// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure prompt/parsing logic plus the `.deep_stats.json` rolling
// ETA store for POST /api/factcheck (task-10-brief.md). Same
// separation-of-concerns as claim.mjs/summary.mjs: no Ollama/network access
// and no node:http req/res concerns live here — router.mjs's SSE handler
// owns the actual streaming, this module owns "what to ask" and "what did
// the answer mean."

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * @typedef {import('../../shared/model.js').Segment} Segment
 */

/**
 * Same defensive-cap rationale as claim.mjs's `CLAIM_CONTEXT_WINDOW_
 * SEGMENTS` (that file's header comment explains why this can't be a real
 * cross-boundary import from shared/*.ts): the client already windows what
 * it sends, this is a second, server-side cap so a future/other caller that
 * forgets to window still can't blow up the prompt size.
 */
export const FACTCHECK_CONTEXT_WINDOW_SEGMENTS = 20;

/**
 * The conversation-so-far transcript text shared by both the quick and deep
 * prompts: every FINAL segment, chronological, capped to the most recent
 * `windowSize`.
 * @param {Segment[]} context
 * @param {number} [windowSize]
 * @returns {string}
 */
function transcript_text(context, windowSize = FACTCHECK_CONTEXT_WINDOW_SEGMENTS) {
  const finalSegments = context
    .filter((s) => s.final)
    .slice()
    .sort((a, b) => a.tStart - b.tStart)
    .slice(-windowSize);
  return finalSegments.map((s) => `${s.speaker ?? '?'}: ${s.text}`).join('\n');
}

/**
 * The "quick" agent's prompt: fast, brief, 2-3 sentences.
 * @param {string} question
 * @param {Segment[]} context
 * @returns {string}
 */
export function build_quick_prompt(question, context) {
  return [
    'You are a fast fact-checking assistant helping during a live conversation.',
    'Give a brief, direct answer (2-3 sentences at most) to the question below, using the conversation',
    'context only if it is relevant. Answer the question itself, not the conversation.',
    '',
    'Conversation so far:',
    transcript_text(context),
    '',
    `Question: ${question}`,
    '',
    'Answer:'
  ].join('\n');
}

/**
 * The "deep" agent's prompt: same question, asked of a slower/larger model
 * with explicit permission to reason more thoroughly and surface nuance.
 * @param {string} question
 * @param {Segment[]} context
 * @returns {string}
 */
export function build_deep_prompt(question, context) {
  return [
    'You are a careful, thorough fact-checking assistant. Take the time to reason carefully before answering.',
    'Answer the question below as accurately and completely as you can, noting any important nuance, caveats,',
    'or uncertainty. Use the conversation context only if it is relevant.',
    '',
    'Conversation so far:',
    transcript_text(context),
    '',
    `Question: ${question}`,
    '',
    'Answer:'
  ].join('\n');
}

/**
 * The one extra quick-model call task-10-brief.md specifies after the deep
 * answer lands: "Do these two answers contradict or materially nuance each
 * other? yes/no + 1 sentence."
 * @param {string} question
 * @param {string} quickText
 * @param {string} deepText
 * @returns {string}
 */
export function build_contradiction_prompt(question, quickText, deepText) {
  return [
    'Two answers were given to the same question by two different fact-checking passes.',
    'Determine whether they contradict each other, or materially nuance/refine each other, or are simply in',
    'agreement. Respond with exactly one word, "yes" or "no", followed by exactly one sentence explaining why',
    '("yes" = they contradict or materially nuance each other; "no" = they agree, with no important nuance).',
    '',
    `Question: ${question}`,
    `Answer A (quick): ${quickText}`,
    `Answer B (deep): ${deepText}`,
    '',
    'Do they contradict or materially nuance each other?'
  ].join('\n');
}

/**
 * @typedef {{ contradicts: boolean; nuance: string }} ContradictionResult
 */

/**
 * Parses the contradiction-check model's raw response. Accepts "yes"/"no"
 * (any case) as the first word, followed by any punctuation/whitespace
 * separator (", ", ": ", " - ", a bare space, or nothing at all) and then
 * the nuance sentence — covering the realistic variants a small local model
 * actually produces ("Yes, they contradict because...", "No.", "NO — they
 * agree", a bare "yes"/"no" with nothing after it). Anything that doesn't
 * start with a recognizable yes/no token (an empty response, or genuine
 * garbage) is treated as `{ contradicts: false, nuance: '' }` per
 * task-10-brief.md's explicit "garbage → contradicts false + no nuance" —
 * never thrown, since a single flaky contradiction-check call must not take
 * down the whole fact-check stream (same "never throws" contract as
 * ollama.mjs's own client).
 * @param {string} raw
 * @returns {ContradictionResult}
 */
export function parse_contradiction_response(raw) {
  const text = (raw ?? '').trim();
  if (!text) return { contradicts: false, nuance: '' };

  const m = /^(yes|no)\b[\s,:;.\-–—]*([\s\S]*)$/i.exec(text);
  if (!m) return { contradicts: false, nuance: '' };

  return { contradicts: m[1].toLowerCase() === 'yes', nuance: m[2].trim() };
}

// ---------------------------------------------------------------------------
// Rolling deep-duration stats (sessions/.deep_stats.json)
// ---------------------------------------------------------------------------

const STATS_FILE = '.deep_stats.json';

/**
 * task-10-brief.md's literal seed value: the ETA shown before any real deep
 * completion has ever been recorded on this machine.
 */
export const DEEP_ETA_SEED_MS = 45000;

/**
 * @typedef {{ avgMs: number; count: number }} DeepStats
 */

/** @returns {DeepStats} */
export function default_deep_stats() {
  return { avgMs: DEEP_ETA_SEED_MS, count: 0 };
}

/**
 * @param {unknown} v
 * @returns {v is DeepStats}
 */
function is_valid_stats(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (/** @type {any} */ (v).avgMs) === 'number' &&
    Number.isFinite(/** @type {any} */ (v).avgMs) &&
    // >= 0, not > 0: a genuinely-recorded duration CAN be 0ms (a
    // near-instant local model response, or an ollama_generate call that
    // resolves synchronously in tests) — that is a legitimate real
    // measurement, not a malformed file. Only a negative number (or the
    // non-finite/wrong-type cases above) indicates real corruption.
    /** @type {any} */ (v).avgMs >= 0 &&
    typeof (/** @type {any} */ (v).count) === 'number' &&
    Number.isFinite(/** @type {any} */ (v).count) &&
    /** @type {any} */ (v).count >= 0
  );
}

/**
 * Reads the rolling deep-duration average from `<sessionsRoot>/.deep_stats.json`.
 * Missing file, malformed JSON, or a shape that doesn't validate all fall
 * back to `default_deep_stats()` (the seed) rather than throwing — this is
 * read on the hot path of every fact-check dispatch, so it must never take
 * the request down.
 * @param {string} sessionsRoot
 * @returns {Promise<DeepStats>}
 */
export async function read_deep_stats(sessionsRoot) {
  try {
    const raw = await readFile(join(sessionsRoot, STATS_FILE), 'utf-8');
    const parsed = JSON.parse(raw);
    return is_valid_stats(parsed) ? { avgMs: parsed.avgMs, count: parsed.count } : default_deep_stats();
  } catch {
    return default_deep_stats();
  }
}

/**
 * Atomically writes `data` as JSON to `filePath` — same write-tmp-then-
 * rename pattern as sessions.mjs's `atomic_write` (duplicated rather than
 * imported: this module has no other dependency on sessions.mjs, and a
 * one-function helper isn't worth introducing a cross-module coupling for).
 * @param {string} filePath
 * @param {unknown} data
 */
async function atomic_write_json(filePath, data) {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, JSON.stringify(data));
  await rename(tmpPath, filePath);
}

/**
 * Records one completed deep-check duration, updating the rolling
 * (cumulative) mean and persisting it. The seed (`DEEP_ETA_SEED_MS`) is
 * only ever the value handed out before any real data exists — it is NOT
 * itself averaged in as a virtual first sample (that would let a real
 * completion's duration get diluted 50/50 against a made-up number
 * forever): the first real completion sets `avgMs` to its own duration
 * outright, `count` becomes 1, and every completion after that folds in
 * normally via the cumulative-mean formula. Callers should skip calling
 * this at all for a duration that doesn't represent a genuine completed
 * deep answer (e.g. Ollama was unreachable) — see router.mjs's fact-check
 * handler.
 * @param {string} sessionsRoot
 * @param {number} ms
 * @returns {Promise<DeepStats>}
 */
export async function record_deep_duration(sessionsRoot, ms) {
  const current = await read_deep_stats(sessionsRoot);
  const count = current.count + 1;
  const avgMs = current.count === 0 ? ms : (current.avgMs * current.count + ms) / count;
  const next = { avgMs, count };
  await mkdir(sessionsRoot, { recursive: true });
  await atomic_write_json(join(sessionsRoot, STATS_FILE), next);
  return next;
}
