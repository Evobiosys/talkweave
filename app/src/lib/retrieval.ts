// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure, model-free retrieval over a session's own segments
// ("ask the conversation" handover, part 2). Framework-free (no runes, no
// DOM, no network), same rationale as flag_helpers.ts/transcript_helpers.ts:
// this is the "algorithmic first" half of the "did we talk about this
// before?" / "was this contradicted elsewhere?" presets — the brief is
// explicit that retrieval must stand on its own with Ollama unreachable,
// so it lives here with zero model/network calls, directly unit-testable.
//
// Scoring: NOT plain Jaccard (`|A∩B|/|A∪B|`). A short highlight matched
// against a long segment that genuinely repeats the highlighted topic
// plus twenty other words would get crushed by the union term — the
// score would fall as the *candidate* grows, independent of whether it
// still says the same thing. Instead this is a directional, idf-weighted
// containment score: "what fraction of the QUERY's own (weight-adjusted)
// content survives in the candidate", normalized only by the query's own
// weight, never the candidate's length.
//
// The idf (inverse document frequency) weighting is what makes the third
// fixture category — "passages that merely share common words and must
// not match" — actually work. A plain stopword list only catches
// function words (the/a/is/of); it does nothing about the high-frequency
// *content* words real conversational transcripts are full of ("think",
// "really", "actually", "know", "like"). Weighting every token by how
// rare it is ACROSS THIS SESSION'S OWN SEGMENTS (not a generic corpus —
// no fixed frequency list would fit every conversation) means a token
// that recurs in nearly every segment contributes close to nothing to
// the score, while a token unique to just a couple of segments carries
// real weight — exactly the signal "did we talk about this before?"
// needs. A query built entirely from session-ubiquitous words ends up
// with ~zero total weight and is correctly refused (see
// `find_related_segments`'s early return) rather than matching whatever
// segment happens to share those same filler words.

import type { Segment } from '../../../shared/model';

/** Splits on runs of letters/digits (keeping a single internal apostrophe,
 *  so "don't"/"it's" stay one token), lowercased. No stemming — good
 *  enough for token-overlap scoring, and keeping it simple keeps this
 *  module trivially auditable. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
}

// Function words only (the/a/is/of/...) — NOT an attempt to also catch
// overused content words, that job belongs to the idf weighting above,
// which adapts per-session rather than guessing at a fixed list.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'because',
  'as', 'of', 'at', 'by', 'for', 'with', 'about', 'into', 'over', 'under',
  'to', 'from', 'in', 'on', 'up', 'down', 'out', 'off', 'again', 'further',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',
  'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose',
  'when', 'where', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'than', 'too', 'very',
  'can', 'will', 'just', 'don', 'should', 'now',
  'there', 'here', 'not'
]);

const MIN_TOKEN_LEN = 2;

/** Tokenizes and strips function words + tokens too short to carry
 *  meaning (single letters). Everything else — including overused
 *  content words — is left in; those are handled by idf weighting, not
 *  by filtering them out here (see file header). */
export function content_tokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

/**
 * Builds a per-token idf (inverse document frequency) lookup over a
 * corpus of token sets — one set per candidate segment, so a token that
 * merely repeats several times WITHIN one segment still only counts once
 * against that segment's document frequency. `idf(t) = ln((N+1)/(df+1))`
 * where `N` is the corpus size and `df` is how many of those documents
 * contain `t`: 0 for a token present in literally every segment (no
 * signal at all — correctly contributes nothing), rising smoothly for
 * rarer tokens, and never negative since `df <= N`.
 */
function build_idf(corpusTokenSets: Set<string>[]): (term: string) => number {
  const df = new Map<string, number>();
  for (const set of corpusTokenSets) {
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = corpusTokenSets.length;
  return (term: string) => {
    const freq = df.get(term) ?? 0;
    return Math.log((n + 1) / (freq + 1));
  };
}

export interface RetrievalMatch {
  segment: Segment;
  score: number;
}

export interface RetrievalOptions {
  /** Excludes one segment id from candidates — the segment the
   *  highlight itself resolved to, so a passage never "recurs" by
   *  matching its own source segment. */
  excludeSegmentId?: string | null;
  /** Minimum RAW (unweighted) shared-token count for a candidate to be
   *  considered at all — a defensive floor under the weighted score so a
   *  single, incidentally-shared token can't be the entire basis for a
   *  match on its own steam without at least this many corroborating
   *  tokens. Default 1 (see this module's test fixtures for why 1, not
   *  higher, is correct: a single rare, highly-specific shared term —
   *  e.g. a proper noun — recurring elsewhere IS a legitimate "talked
   *  about this before" signal). */
  minSharedTokens?: number;
  /** Minimum idf-weighted containment score (0-1-ish; can exceed 1 only
   *  if a segment repeats a query token multiple times, which `Set`-based
   *  containment here never does — effectively capped at 1). Calibrated
   *  against a real recurring pair, not picked a priori (E2E proof, this
   *  handover): a highlighted passage with several of its own
   *  never-repeated words (e.g. "the grant, enough to finish the map and
   *  run the ... pilot") genuinely recurring elsewhere, restated with
   *  different filler around the same distinctive content ("forty
   *  thousand euros", "feasibility study"), scored ~0.33 — below the
   *  0.35 this was first written with, which would have silently failed
   *  the exact "genuinely recurs" case this feature exists for. 0.3
   *  keeps the same wide margin over the "must not match" fixtures
   *  (which score exactly 0, caught by the `queryWeight <= 0` guard
   *  above, not this threshold) while no longer rejecting a real,
   *  undeniable recurrence just because the query itself was verbose. */
  minScore?: number;
  /** Caps how many matches come back, highest score first. */
  limit?: number;
}

export const RETRIEVAL_DEFAULT_MIN_SHARED_TOKENS = 1;
export const RETRIEVAL_DEFAULT_MIN_SCORE = 0.3;
export const RETRIEVAL_DEFAULT_LIMIT = 10;

/**
 * Searches `segments` for the ones most likely "about the same thing" as
 * `query` (a highlighted passage, or a free-form question). Only FINAL
 * segments are eligible (a still-partial live segment isn't a stable
 * thing to point the user at). Returns matches ordered by score
 * descending, ties broken by earliest `tStart` — deterministic and, per
 * the brief, immediately jumpable/orderable by the caller with zero model
 * involvement.
 *
 * Returns `[]` when the query itself carries no usable signal — either
 * no content tokens at all (an all-stopword or empty query) or every one
 * of its content tokens is idf-weight-zero (recurs in literally every
 * candidate segment, i.e. pure filler with no distinguishing content) —
 * rather than falling through to an undefined 0/0 score.
 */
export function find_related_segments(query: string, segments: Segment[], options: RetrievalOptions = {}): RetrievalMatch[] {
  const queryTokens = content_tokens(query);
  if (queryTokens.length === 0) return [];

  const candidates = segments.filter((s) => s.final && s.id !== options.excludeSegmentId);
  if (candidates.length === 0) return [];

  const candidateTokenSets = candidates.map((s) => new Set(content_tokens(s.text)));
  const idf = build_idf(candidateTokenSets);

  const uniqueQueryTokens = [...new Set(queryTokens)];
  const queryWeight = uniqueQueryTokens.reduce((sum, t) => sum + idf(t), 0);
  if (queryWeight <= 0) return [];

  const minShared = options.minSharedTokens ?? RETRIEVAL_DEFAULT_MIN_SHARED_TOKENS;
  const minScore = options.minScore ?? RETRIEVAL_DEFAULT_MIN_SCORE;
  const limit = options.limit ?? RETRIEVAL_DEFAULT_LIMIT;

  const matches: RetrievalMatch[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const segTokens = candidateTokenSets[i];
    if (segTokens.size === 0) continue;

    let shared = 0;
    let sharedWeight = 0;
    for (const t of uniqueQueryTokens) {
      if (segTokens.has(t)) {
        shared += 1;
        sharedWeight += idf(t);
      }
    }
    if (shared < minShared) continue;

    const score = sharedWeight / queryWeight;
    if (score < minScore) continue;

    matches.push({ segment: candidates[i], score });
  }

  matches.sort((a, b) => b.score - a.score || a.segment.tStart - b.segment.tStart);
  return matches.slice(0, limit);
}
