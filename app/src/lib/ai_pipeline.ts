// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure AI-pipeline orchestration decisions (Task 9 fix round
// 1). Extracted out of app.svelte so each decision is directly
// unit-testable under plain vitest, same rationale as session_store_core.ts
// / keymap.ts's `decide_key`: app.svelte wires these into fetch calls and
// $state, but the DECISIONS themselves (should this flag even go through
// AI? how much context to send? is a summary already in flight? should the
// offline chip change?) contain the actual logic worth getting right and
// regression-testing.

import type { Flag, Segment } from '../../../shared/model';

/**
 * Review fix round 1, Important 2 ("unbounded prompt context"): the
 * MAXIMUM number of final segments `window_claim_context` sends down to
 * `/api/llm/claim`, nearest-to-`flagT` first. Kept as a plain local
 * constant, not a shared cross-boundary import — mirrored by
 * `server/lib/claim.mjs`'s own `CLAIM_CONTEXT_WINDOW_SEGMENTS` (that
 * file's header comment explains why a real runtime import between the
 * two isn't safe here: it would resolve under `tsc`'s type-checking but
 * fail at actual `node server/server.mjs` runtime, since `shared/*.ts`
 * has no build step producing a real `.js`/`.mjs` file for Node to load).
 * Keep both in sync if this number ever changes.
 */
export const CLAIM_CONTEXT_WINDOW_SEGMENTS = 12;

/**
 * Review fix round 1, Critical 1: a `dblclick` flag already carries an
 * exact, user-chosen `segmentId`/`charStart`/`charEnd` — there is nothing
 * to "upgrade." Running it through `/api/llm/claim` anyway resolves
 * "nearest final segment before `flagT`" independently of what the user
 * actually clicked (`flagT` is just `current_t()` at keypress time, not
 * the clicked segment's own timing), and `update_flag_claim` then
 * overwrites the user's deliberate selection wholesale with that
 * unrelated result. Only a `'key'`-sourced flag (Shift/Space — created
 * with a null span, genuinely needing the AI pipeline to fill it in) is
 * eligible.
 */
export function should_extract_claim_for_flag(flag: Flag): boolean {
  return flag.source === 'key';
}

/**
 * Review fix round 1, Important 2: windows `segments` down to the most
 * recent `windowSize` FINAL segments strictly before `flagT` (nearest to
 * `flagT` first internally, returned chronological) before sending them as
 * `/api/llm/claim`'s `context` — the original implementation sent the
 * ENTIRE session's segments on every flag, an unbounded and ever-growing
 * prompt. `server/lib/claim.mjs`'s `build_claim_prompt` applies the same
 * `CLAIM_CONTEXT_WINDOW_SEGMENTS` cap defensively on its own side, so the
 * two can never silently drift out of agreement.
 */
export function window_claim_context(
  segments: Segment[],
  flagT: number,
  windowSize: number = CLAIM_CONTEXT_WINDOW_SEGMENTS
): Segment[] {
  const eligible = segments.filter((s) => s.final && s.tStart < flagT).sort((a, b) => a.tStart - b.tStart);
  return eligible.slice(-windowSize);
}

/**
 * Review fix round 1, Important 4: the "local AI offline" chip must only
 * ever change based on a call that genuinely reached (or failed to reach)
 * Ollama. `ollamaAvailable === null` — the server's signal for "Ollama was
 * never contacted this call" (e.g. `/api/llm/claim` had no eligible
 * segment to even build a prompt for) — leaves `current` untouched rather
 * than defaulting to "available" (which would wrongly clear an
 * already-showing offline chip) or "offline" (which would wrongly show one
 * with no evidence at all).
 */
export function ollama_offline_next_state(current: boolean, ollamaAvailable: boolean | null): boolean {
  if (ollamaAvailable === null) return current;
  return !ollamaAvailable;
}

/**
 * Review fix round 1, Important 3: guards `trigger_summary` against
 * overlapping calls — a >15s generation left the next interval poll free
 * to re-fire with the same `tFrom`, since nothing tracked "a summary
 * request is already in flight." Framework-free (a plain closure over one
 * boolean, same factory-function shape as autosave.ts's
 * `create_autosave_controller`) so the guard itself is unit-testable
 * without touching app.svelte's `$state`.
 */
export interface InFlightGuard {
  /** True while a call is in flight. */
  is_busy(): boolean;
  /** Attempts to start a new call: returns `true` (and marks busy) only if
   *  not already busy; `false` — meaning "skip, one's already running" —
   *  when a call is already in flight. */
  try_start(): boolean;
  /** Marks the in-flight call as finished, so the next `try_start()`
   *  succeeds. */
  finish(): void;
}

export function create_in_flight_guard(): InFlightGuard {
  let busy = false;
  return {
    is_busy: () => busy,
    try_start: () => {
      if (busy) return false;
      busy = true;
      return true;
    },
    finish: () => {
      busy = false;
    }
  };
}
