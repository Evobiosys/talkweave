// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure prompt-building for POST /api/ask ("ask the
// conversation about itself" handover, part 2's model-judging step). Same
// separation-of-concerns as claim.mjs/summary.mjs/factcheck.mjs: no
// Ollama/network access and no node:http req/res concerns live here —
// router.mjs's handler owns the actual Ollama call, this module owns
// "what to ask."
//
// Deliberately does NOT duplicate `factcheck.mjs`'s `build_contradiction_
// prompt`/`parse_contradiction_response` — router.mjs reuses those
// directly for the "was this contradicted elsewhere?" preset (the
// handover is explicit: "reuse them rather than writing a second
// contradiction prompt"). This file only adds the two prompts that genuinely
// have no existing equivalent: "are these the same topic" (the "did we
// talk about this before?" preset's judging step) and the free-form
// ask's transcript-only answer.
//
// Answering from the transcript, not the world: unlike factcheck.mjs's
// quick/deep prompts (which explicitly invite outside/world knowledge —
// "fact-checking assistant"), both prompts here are scoped to ONLY the
// conversation's own words. That is the entire point of "ask the
// conversation about itself" as distinct from "fact-check a highlight."

import { FACTCHECK_CONTEXT_WINDOW_SEGMENTS } from './factcheck.mjs';

/**
 * @typedef {{ segmentId: string; speaker: string | null; tStart: number; text: string }} AskCandidate
 */

/**
 * "Did we talk about this before?" preset's judging step: given the
 * highlighted passage and the single top-scored retrieval match, asks
 * whether they are genuinely the same topic (not merely sharing a few
 * words — the retrieval step already filtered for token overlap; this is
 * a semantic double-check on TOP of that, same "algorithmic first, AI
 * second" order the brief requires). Reuses `factcheck.mjs`'s
 * `parse_contradiction_response` at the call site (see router.mjs) since
 * that parser already accepts "yes/no + one sentence" in every realistic
 * small-model phrasing — the response shape this prompt asks for is
 * identical to the one that parser was built against.
 * @param {string} passage
 * @param {string} candidateText
 * @returns {string}
 */
export function build_same_topic_prompt(passage, candidateText) {
  return [
    'Two passages are shown below, both taken from the same recorded conversation.',
    'Decide whether they are genuinely about the SAME topic or claim — not merely sharing a few words — i.e.',
    'whether passage B is a real earlier instance of the same thing being discussed in passage A.',
    'Respond with exactly one word, "yes" or "no", followed by exactly one sentence explaining why.',
    '',
    `Passage A (just highlighted): ${passage}`,
    `Passage B (found earlier in the conversation): ${candidateText}`,
    '',
    'Are these the same topic?'
  ].join('\n');
}

/**
 * Renders a shortlist of retrieved candidates as `SPEAKER: text` lines,
 * chronological, capped to `windowSize` — the same transcript-text shape
 * `factcheck.mjs`'s prompts use, but built from the CLIENT's already-
 * retrieved shortlist (app/src/lib/retrieval.ts) rather than a plain
 * recency window: free-form ask is answered from what's relevant, not
 * from whatever happens to be most recent.
 * @param {AskCandidate[]} candidates
 * @param {number} windowSize
 * @returns {string}
 */
function candidates_text(candidates, windowSize) {
  return candidates
    .slice()
    .sort((a, b) => a.tStart - b.tStart)
    .slice(0, windowSize)
    .map((c) => `${c.speaker ?? '?'}: ${c.text}`)
    .join('\n');
}

/**
 * Free-form "ask the conversation" prompt: answers the user's own
 * question using ONLY the retrieved transcript excerpts — explicitly
 * forbidden from falling back to outside/world knowledge, which is what
 * makes this a different feature from fact-checking rather than a
 * renamed copy of it. An empty `candidates` list (retrieval found
 * nothing relevant) still produces a valid prompt whose honest answer is
 * "the transcript doesn't say" — never silently swapped for a
 * fact-check-style world-knowledge answer.
 * @param {string} question
 * @param {AskCandidate[]} candidates
 * @param {number} [windowSize]
 * @returns {string}
 */
export function build_freeform_prompt(question, candidates, windowSize = FACTCHECK_CONTEXT_WINDOW_SEGMENTS) {
  const transcript = candidates_text(candidates, windowSize);
  return [
    'You are answering a question about a recorded conversation, using ONLY the transcript excerpts below.',
    'Do not use outside/world knowledge and do not fact-check anything — answer strictly from what was said in',
    'this conversation. If the excerpts do not contain an answer, say so plainly rather than guessing.',
    '',
    'Relevant transcript excerpts:',
    transcript || '(no matching excerpts were found in this conversation)',
    '',
    `Question: ${question}`,
    '',
    'Answer:'
  ].join('\n');
}
