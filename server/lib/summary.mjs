// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure summary-prompt/formatting logic for POST
// /api/llm/summary (task-9-brief.md). Same separation-of-concerns as
// claim.mjs: no Ollama/network access lives here.

/**
 * @typedef {import('../../shared/model.js').Segment} Segment
 */

/**
 * Builds the prompt for a ≤3-bullet summary of every FINAL segment
 * overlapping `[tFrom, tTo)`.
 * @param {Segment[]} segments
 * @param {number} tFrom
 * @param {number} tTo
 * @returns {string}
 */
export function build_summary_prompt(segments, tFrom, tTo) {
  const relevant = segments
    .filter((s) => s.final && s.tEnd > tFrom && s.tStart < tTo)
    .slice()
    .sort((a, b) => a.tStart - b.tStart);
  const transcript = relevant.map((s) => `${s.speaker ?? '?'}: ${s.text}`).join('\n');

  return [
    'Summarize the following conversation excerpt in at most 3 short bullet points.',
    'Return ONLY the bullets, one per line, each starting with "- " — no preamble, no closing remarks.',
    '',
    'Transcript:',
    transcript,
    '',
    'Summary:'
  ].join('\n');
}

/**
 * Trims a raw LLM summary response down to at most `max` non-empty lines
 * (task-9-brief.md's "≤3 bullet summary") — a defensive cap in case the
 * model ignores the prompt's own limit, not a re-formatter: whatever
 * bullet marker/wording the model used is passed through unchanged.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate_to_bullets(text, max = 3) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return text.trim();
  return lines.slice(0, max).join('\n');
}
