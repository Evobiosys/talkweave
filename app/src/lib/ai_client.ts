// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — thin fetch wrappers for the server's /api/llm/* routes
// (Task 9). All prompt-building/validation/fallback/degradation logic
// lives server-side (server/lib/claim.mjs, server/lib/summary.mjs,
// server/lib/ollama.mjs) — this module's only job is the wire format, plus
// defending against OUR OWN server being unreachable (distinct from Ollama
// being down, which the server already degrades gracefully for and always
// answers 200 to `/api/llm/claim` regardless of).
//
// Returns `null` on any transport-level failure (network error, non-2xx
// status, malformed JSON body) rather than throwing — callers (app.svelte)
// treat `null` as "couldn't even ask," a strict superset of the server's
// own `ollamaAvailable`/`unavailable` degradation fields, and just skip
// the update: nothing in this local-only, single-user app surfaces an
// error dialog for a dropped AI call.

import type { Segment } from '../../../shared/model';

export interface ClaimRequest {
  context: Segment[];
  flagT: number;
  principles?: string;
  model?: string;
}

export interface ClaimResponse {
  claim: string | null;
  segmentId: string | null;
  charStart: number | null;
  charEnd: number | null;
  via: 'llm' | 'fallback';
  /**
   * `false` when the server's Ollama call itself reported unavailable;
   * `true` when it genuinely answered (regardless of whether that answer
   * validated — see `via`); `null` when Ollama was never contacted at all
   * (no eligible other-speaker segment existed to even build a prompt
   * for). Review fix round 1, Important 4: `null` must NOT be coerced to
   * either boolean here — `ollama_offline_next_state` (ai_pipeline.ts) is
   * the one place that decides what a `null` means for the "local AI
   * offline" chip (answer: leave it as it was).
   */
  ollamaAvailable: boolean | null;
}

export async function fetch_claim(req: ClaimRequest): Promise<ClaimResponse | null> {
  try {
    const res = await fetch('/api/llm/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    return {
      claim: typeof data.claim === 'string' ? data.claim : null,
      segmentId: typeof data.segmentId === 'string' ? data.segmentId : null,
      charStart: typeof data.charStart === 'number' ? data.charStart : null,
      charEnd: typeof data.charEnd === 'number' ? data.charEnd : null,
      via: data.via === 'llm' ? 'llm' : 'fallback',
      ollamaAvailable: data.ollamaAvailable === true ? true : data.ollamaAvailable === false ? false : null
    };
  } catch {
    return null;
  }
}

export interface SummaryRequest {
  segments: Segment[];
  tFrom: number;
  tTo: number;
  model?: string;
}

export interface SummaryResponse {
  unavailable: boolean;
  text: string | null;
}

export async function fetch_summary(req: SummaryRequest): Promise<SummaryResponse | null> {
  try {
    const res = await fetch('/api/llm/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    return {
      unavailable: data.unavailable === true,
      text: typeof data.text === 'string' ? data.text : null
    };
  } catch {
    return null;
  }
}
