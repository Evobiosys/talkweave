// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — generic debounced-save controller.
//
// Pure, framework-free (no runes): notify() (re)starts a debounceMs timer,
// firing `save` once activity settles. Deliberately separated out of
// session_store.svelte.ts so the debounce behavior itself is unit-testable
// under plain vitest with `vi.useFakeTimers()` — a `.svelte.ts` module can't
// be imported directly by this repo's test runner (see
// session_store_core.ts's header comment / task-3-report.md for why).
//
// Fix round 2 (task-8-report.md): a pure "reset the timer on every notify()"
// debounce never fires at all while notify() keeps arriving faster than
// `debounceMs` — exactly what Task 8's ReplayEngine does (partial ticks
// every ~350ms, far under the 2000ms settle window). Confirmed empirically:
// a demo session's segments were never actually written to session.md until
// the entire ~36-turn fixture finished playing, tens of seconds to minutes
// in. Any future continuously-streaming engine (v0.2's real mic transcriber)
// would hit the identical starvation.
//
// `MAX_WAIT_MS` fixes this with a second, independent timer that is armed
// once — on the first notify() of an otherwise-unsaved burst — and is NEVER
// reset by later notify() calls within that same burst. Whichever timer
// fires first (the settle debounce, when activity genuinely pauses, or the
// max-wait ceiling, when it doesn't) runs the save and clears both timers,
// so the next notify() starts a fresh burst with its own fresh max-wait
// window. This preserves every existing semantic exactly: a single notify()
// still saves after one `debounceMs` (well under `MAX_WAIT_MS`, so max-wait
// never fires first in that case), `cancel()` still cancels everything
// pending, and `flush()` still saves immediately and clears both timers.

const MAX_WAIT_MS = 10000;

export interface AutosaveController {
  /** (Re)starts the debounce window. Call after any change that should
   *  eventually be persisted. */
  notify(): void;
  /** Cancels a pending debounced save without running it. */
  cancel(): void;
  /** Cancels any pending debounce and runs `save` immediately, e.g. on
   *  page unload. Awaits the save so callers can be sure it landed. */
  flush(): Promise<void>;
}

export function create_autosave_controller(
  save: () => void | Promise<void>,
  debounceMs: number,
  maxWaitMs: number = MAX_WAIT_MS
): AutosaveController {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  function clear_timers(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function run_save(): void {
    // Clear BEFORE calling `save`, not after: `save` may itself be
    // synchronous and trigger a re-entrant `notify()` (not the case
    // today, but nothing here should assume otherwise) — clearing first
    // means that re-entrant call sees a clean slate and arms its own
    // fresh burst, rather than colliding with timer handles this call is
    // about to discard anyway.
    clear_timers();
    void save();
  }

  function cancel(): void {
    clear_timers();
  }

  function notify(): void {
    // Settle window: always (re)armed on every call — unchanged behavior.
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run_save, debounceMs);

    // Max-wait ceiling: armed ONLY when there is no unsaved burst already
    // in flight (`maxWaitTimer === null`) — this is what makes it a
    // ceiling on the whole burst rather than just another debounce that
    // continuous notify() calls could reset forever.
    if (maxWaitTimer === null) {
      maxWaitTimer = setTimeout(run_save, maxWaitMs);
    }
  }

  async function flush(): Promise<void> {
    clear_timers();
    await save();
  }

  return { notify, cancel, flush };
}
