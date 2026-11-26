// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — client-side transport for POST /api/factcheck's SSE stream
// (Task 10). Real transport is `fetch` with a streamed response body, NOT
// the browser's native `EventSource`: `EventSource` can only ever issue a
// GET with no body, and this endpoint's payload (question + transcript
// context + model names) is a POST body, per task-10-brief.md's literal
// route signature. This module hand-rolls the same "event:\ndata:\n\n"
// block parsing `EventSource` would otherwise do, split into a pure parser
// (`parse_sse_block`/`dispatch_sse_event`, directly unit-testable) and the
// actual fetch/stream-reading side effect (`start_factcheck_stream`) —
// same separation as every other pure-decision/thin-plumbing pair in this
// codebase (keymap.ts's `decide_key` vs `bind_keymap`, etc).
//
// Abort: task-10-brief.md's "server kills in-flight ollama requests" relies
// on the CLIENT actually tearing down the connection — `start_factcheck_
// stream`'s returned `abort()` calls `AbortController.abort()` on the same
// controller passed to `fetch`, which drops the TCP connection the server's
// `res.on('close', ...)` (router.mjs) is watching for.

import type { Segment } from '../../../shared/model';

export interface FactCheckRequest {
  question: string;
  context: Segment[];
  models: { quick: string; deep: string };
}

export interface FactCheckQuickEvent {
  text: string;
  model: string;
  ms: number;
}

export interface FactCheckDeepEtaEvent {
  etaMs: number;
}

export interface FactCheckDeepEvent {
  text: string;
  model: string;
  ms: number;
  contradicts: boolean;
  /** Empty string when the contradiction check found nothing worth stating
   *  or its response didn't parse — see server/lib/factcheck.mjs's
   *  `parse_contradiction_response`. */
  nuance: string;
}

export interface FactCheckStreamHandlers {
  onQuick?: (data: FactCheckQuickEvent) => void;
  onDeepEta?: (data: FactCheckDeepEtaEvent) => void;
  onDeep?: (data: FactCheckDeepEvent) => void;
  onDone?: () => void;
}

export interface FactCheckStreamHandle {
  abort(): void;
}

/**
 * Parses one already-split (on the blank-line `\n\n` delimiter) SSE block
 * into its `event`/`data` pair. Tolerant of field order and of a block
 * missing one or both fields (returns `null` rather than throwing) — a
 * trailing empty chunk from `buffer.split('\n\n')` is exactly this case in
 * practice.
 */
export function parse_sse_block(block: string): { event: string; data: string } | null {
  let event: string | null = null;
  let data: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data = line.slice('data:'.length).trim();
  }
  if (event === null || data === null) return null;
  return { event, data };
}

/**
 * Validates + routes one parsed SSE event to the matching handler. Malformed
 * JSON or a payload missing/mistyping a required field is silently skipped
 * — same "never let one bad chunk kill the whole stream" contract as
 * ollama.mjs's own malformed-line handling — rather than calling a handler
 * with a shape it doesn't expect.
 */
export function dispatch_sse_event(event: string, rawData: string, handlers: FactCheckStreamHandlers): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const d = parsed as Record<string, unknown>;

  if (event === 'quick') {
    if (typeof d.text === 'string' && typeof d.model === 'string' && typeof d.ms === 'number') {
      handlers.onQuick?.({ text: d.text, model: d.model, ms: d.ms });
    }
  } else if (event === 'deep_eta') {
    if (typeof d.etaMs === 'number') handlers.onDeepEta?.({ etaMs: d.etaMs });
  } else if (event === 'deep') {
    if (
      typeof d.text === 'string' &&
      typeof d.model === 'string' &&
      typeof d.ms === 'number' &&
      typeof d.contradicts === 'boolean'
    ) {
      handlers.onDeep?.({
        text: d.text,
        model: d.model,
        ms: d.ms,
        contradicts: d.contradicts,
        nuance: typeof d.nuance === 'string' ? d.nuance : ''
      });
    }
  } else if (event === 'done') {
    handlers.onDone?.();
  }
}

/**
 * Starts a fact-check SSE stream and returns immediately with an `abort()`
 * handle — the network/parse work runs as a detached async task. Same
 * "never throws, degrade silently" contract as ai_client.ts's fetch
 * wrappers: a dropped connection, a non-2xx response, or an aborted fetch
 * all just stop delivering events, with no error callback in this v0.1
 * scope (the docked card's own UI already shows "nothing happened" plainly
 * enough — a quick/deep answer that never arrives).
 */
export function start_factcheck_stream(req: FactCheckRequest, handlers: FactCheckStreamHandlers): FactCheckStreamHandle {
  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await fetch('/api/factcheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal
      });
    } catch {
      return;
    }
    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const parsedBlock = parse_sse_block(block);
          if (parsedBlock) dispatch_sse_event(parsedBlock.event, parsedBlock.data, handlers);
        }
      }
    } catch {
      // aborted mid-read, or a transport error — nothing further to do.
    }
  })();

  return { abort: () => controller.abort() };
}
