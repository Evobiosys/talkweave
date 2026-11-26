// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — client-side transport for POST /api/ask ("ask the
// conversation about itself", the model-judging half of the feature).
// A single plain fetch, not SSE — server/lib/router.mjs's `handle_ask`
// doc comment explains why: this route is always exactly one Ollama
// call, never factcheck's two-stage quick+deep reveal, so there's
// nothing progressive to stream. Abort still works the same way
// factcheck_client.ts's does: the returned `abort()` calls
// `AbortController.abort()`, which drops the connection the server's
// `res.on('close', ...)` is watching for.

import type { AskMode } from './ask_reducer';

export interface AskCandidate {
  segmentId: string;
  speaker: 'L' | 'R' | null;
  tStart: number;
  text: string;
}

export interface AskRequest {
  mode: AskMode;
  /** The highlighted passage (recall/contradiction) or the user's own
   *  free-form question. */
  question: string;
  /** The already-retrieved shortlist (app/src/lib/retrieval.ts), highest
   *  score first — this module never re-derives it, only forwards it. */
  candidates: AskCandidate[];
  model?: string;
}

export interface AskResult {
  ok: boolean;
  /** `true` = Ollama was reached but the call never came back;
   *  `false` = a real answer arrived; `null` = never contacted Ollama at
   *  all (e.g. no candidate to judge) — same three-state convention as
   *  `/api/llm/claim`'s `ollamaAvailable`. */
  unavailable: boolean | null;
  text: string | null;
  sameTopic?: boolean;
  contradicts?: boolean;
}

export interface AskHandle {
  abort(): void;
}

const NETWORK_ERROR_RESULT: AskResult = { ok: false, unavailable: true, text: null };

/**
 * Validates + normalizes one already-parsed `/api/ask` JSON body into an
 * `AskResult` — the pure half of this module, directly unit-testable
 * without a real `fetch` (same split as factcheck_client.ts's
 * `parse_sse_block`/`dispatch_sse_event` vs. `start_factcheck_stream`).
 * A response missing/mistyping a field never throws; it's treated the
 * same as a network failure (`NETWORK_ERROR_RESULT`) — a malformed
 * server response is exactly as unusable to the caller as no response
 * at all.
 */
export function parse_ask_response(data: unknown): AskResult {
  if (!data || typeof data !== 'object') return NETWORK_ERROR_RESULT;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return NETWORK_ERROR_RESULT;
  return {
    ok: true,
    unavailable: typeof d.unavailable === 'boolean' ? d.unavailable : null,
    text: typeof d.text === 'string' ? d.text : null,
    sameTopic: typeof d.sameTopic === 'boolean' ? d.sameTopic : undefined,
    contradicts: typeof d.contradicts === 'boolean' ? d.contradicts : undefined
  };
}

/**
 * Starts one `/api/ask` request and returns immediately with an
 * `abort()` handle — same "never throws, degrade silently" contract as
 * factcheck_client.ts: a dropped connection, non-2xx response, an
 * unparseable body, or an aborted fetch all resolve as
 * `NETWORK_ERROR_RESULT` via `onResult`, never an exception the caller
 * has to catch. An abort specifically (the card's own dismiss button)
 * calls `onResult` too, same as every other failure path — the reducer's
 * `dismiss` action, already applied synchronously by the caller before
 * `abort()` is even called, is what actually suppresses this from
 * resurrecting a dismissed card (see ask_reducer.ts).
 */
export function start_ask(req: AskRequest, onResult: (result: AskResult) => void): AskHandle {
  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal
      });
    } catch {
      onResult(NETWORK_ERROR_RESULT);
      return;
    }
    if (!res.ok) {
      onResult(NETWORK_ERROR_RESULT);
      return;
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      onResult(NETWORK_ERROR_RESULT);
      return;
    }
    onResult(parse_ask_response(data));
  })();

  return { abort: () => controller.abort() };
}
