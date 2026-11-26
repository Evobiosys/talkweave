// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — Task 14 fix: the top bar's show/hide decision, extracted out
// of app.svelte into a pure reducer (same rationale as factcheck_reducer.ts
// / session_mode_plan.ts — the DECISIONS are what regress silently, so they
// live somewhere a test can hit every transition without a Svelte
// component or a real DOM).
//
// Bug this replaces: the old logic tracked `event.clientY` against two
// thresholds (`HOVER_SHOW_PX` reveal / `HOVER_HIDE_PX` hide-again) on a
// window-level `mousemove`. That's "pointer near the top of the SCREEN,"
// not "pointer inside the BAR" — the two coincide only while the bar is
// still hidden. Once revealed, the bar's own fields sit well past 64px
// down, so moving the mouse DOWN into them crossed `HOVER_HIDE_PX` and
// slid the bar shut out from under the cursor (Jakob bug 2026-08-22).
//
// Fix shape: `visible` is now driven by whether the pointer is *actually
// over the header element* (`pointer_enter`/`pointer_leave`, fired from
// the header's own `onpointerenter`/`onpointerleave` — real hit-testing,
// not a coordinate guess), by focus (`focus_in`/`focus_out`, Task 6,
// unchanged in spirit), and by the `,` pin — instead of by how far down
// the screen the pointer has traveled. `edge_hover` still exists to
// REVEAL the bar in the first place (`app.svelte`'s window `mousemove`,
// unchanged threshold) — that part of the bug report ("reveal on
// near-top-edge hover ... as today") was never wrong, only the retreat
// side was.
//
// Crucial design point: `overHeader`/`focusWithin`/`pinned` are NOT
// OR'd together to produce `visible` the way the old
// `hoverShow || pinned || focusWithin` derived did. That shape is exactly
// what broke the "no flicker between fields" requirement in fix round 1
// of this task — clearing `focusWithin` the instant a `focus_out` fires
// (before the grace delay, before the very next `focus_in` from the field
// the user tabbed/clicked INTO) would drop a bare OR straight to `false`
// with no delay at all, since none of the three flags was still true in
// that instant. Instead, `visible` is its own field, an independent piece
// of state that only ever flips on the SAME event that sets one of the
// hold flags true (immediate — a reveal is never delayed), and only ever
// flips off inside `tick`, once a scheduled deadline has actually passed
// AND, checked again at that moment, none of the three hold flags is
// true any more. A `focus_in` arriving before that deadline (the
// field-to-field case) simply clears the deadline — `visible` was never
// touched, so there is nothing to flicker back on.
//
// `pointer_outside` (advisor review, fix round 1) closes a hole a pure
// enter/leave pair can't: the window `mousemove` handler fires this
// whenever `!state.overHeader`, covering a pointer that never actually
// enters the header at all — e.g. a fast flick from y=5 straight to
// y=400, past wherever the header's bottom edge lands, generating no
// `pointerenter`/`pointerleave` pair for the header to react to. Without
// it, `edge_hover` reveals the bar and nothing ever schedules a hide,
// which is a straight regression against the old `HOVER_HIDE_PX` (that
// clientY check DID fire on every mousemove, flick included). The
// reducer guards this to fire the *same* grace deadline `pointer_leave`
// would — never a second, earlier one — so a stream of `mousemove`
// events outside the header cannot keep pushing the hide deadline
// further out than the first one it set.
//
// `,` (`toggle_pin`) is the one path with NO grace delay in either
// direction: pinning on reveals immediately, and unpinning retreats
// immediately UNLESS the pointer is over the header or focus is inside
// it — in which case unpinning simply drops the `pinned` flag and leaves
// `visible` alone, since one of the other two holds is still keeping it
// open (a later `pointer_leave`/`focus_out` from THAT hold will schedule
// its own grace-delayed retreat same as always).

export interface TopBarState {
  /** The bar's actual on-screen visibility. Set `true` the instant any
   *  reveal event fires; set `false` only inside `tick`, once a scheduled
   *  deadline has passed and, re-checked at that moment, nothing is still
   *  holding it open. */
  visible: boolean;
  /** True while the pointer is inside the header's own hit-test region
   *  (between that element's `pointerenter` and its `pointerleave`). */
  overHeader: boolean;
  /** True while focus (any descendant, e.g. a name field or a settings
   *  control) sits inside the header — Task 6's hold, unchanged. */
  focusWithin: boolean;
  /** True while pinned open via the `,` key or the gear button. */
  pinned: boolean;
  /** Timestamp (`Date.now()`-comparable) a scheduled hide should fire at,
   *  or `null` when nothing is scheduled. Never more than one deadline
   *  live at a time — see `pointer_outside`. */
  pendingHideAt: number | null;
}

export type TopBarEvent =
  | { type: 'edge_hover' }
  | { type: 'pointer_enter' }
  | { type: 'pointer_leave'; now: number; graceMs: number }
  | { type: 'pointer_outside'; now: number; graceMs: number }
  | { type: 'focus_in' }
  | { type: 'focus_out'; now: number; graceMs: number }
  | { type: 'toggle_pin' }
  | { type: 'tick'; now: number };

export function init_top_bar_state(): TopBarState {
  return { visible: false, overHeader: false, focusWithin: false, pinned: false, pendingHideAt: null };
}

/** The bar's current on-screen visibility. A thin, named accessor (kept
 *  for symmetry with the old `topBarVisible` derived app.svelte read) —
 *  `state.visible` is already the single source of truth; the three hold
 *  flags are reducer INPUTS, not re-derived here. */
export function top_bar_visible(state: TopBarState): boolean {
  return state.visible;
}

/** Whether something is currently holding the bar open — used by `tick`
 *  to decide whether a due deadline actually gets to hide it. */
function is_held_open(state: TopBarState): boolean {
  return state.overHeader || state.focusWithin || state.pinned;
}

/**
 * Pure transition. Every event that could make the bar retreat only ever
 * records/clears a deadline (`pendingHideAt`) — `app.svelte` is the only
 * place that turns a deadline into an actual hide, by feeding a `tick`
 * back in once it has passed (see that file's `schedule_hide_check`).
 */
export function top_bar_reducer(state: TopBarState, event: TopBarEvent): TopBarState {
  switch (event.type) {
    case 'edge_hover':
      // Reveals the bar and, since the pointer approaching from off the
      // header is clearly intentional, cancels anything already scheduled
      // (a hide queued from a previous visit shouldn't fire mid-reveal).
      return { ...state, visible: true, pendingHideAt: null };

    case 'pointer_enter':
      return { ...state, visible: true, overHeader: true, pendingHideAt: null };

    case 'pointer_leave': {
      const next = { ...state, overHeader: false };
      if (state.focusWithin || state.pinned) return { ...next, pendingHideAt: null };
      return { ...next, pendingHideAt: event.now + event.graceMs };
    }

    case 'pointer_outside':
      // Only relevant once the bar has actually been revealed — and only
      // schedules when nothing already has (idempotent: a stream of
      // mousemoves outside the header must not keep pushing the deadline
      // out further than the first one set it) and nothing else is
      // already holding it open.
      if (!state.visible || is_held_open(state) || state.pendingHideAt !== null) return state;
      return { ...state, pendingHideAt: event.now + event.graceMs };

    case 'focus_in':
      return { ...state, visible: true, focusWithin: true, pendingHideAt: null };

    case 'focus_out': {
      const next = { ...state, focusWithin: false };
      if (state.overHeader || state.pinned) return { ...next, pendingHideAt: null };
      return { ...next, pendingHideAt: event.now + event.graceMs };
    }

    case 'toggle_pin': {
      const pinned = !state.pinned;
      if (pinned) return { ...state, pinned, visible: true, pendingHideAt: null };
      // Unpinning: no grace delay either way. Retreat instantly unless
      // the pointer or focus is still inside the bar, in which case that
      // hold stays in charge of when it eventually retreats.
      if (state.overHeader || state.focusWithin) return { ...state, pinned };
      return { ...state, pinned, visible: false, pendingHideAt: null };
    }

    case 'tick': {
      if (state.pendingHideAt === null || event.now < state.pendingHideAt) return state;
      // The deadline is due. Re-check: a hold could have been reasserted
      // (e.g. `focus_in` on the very next field) without ever clearing
      // this deadline in every code path — belt-and-suspenders per the
      // advisor review's note on early/duplicate timer firing.
      if (is_held_open(state)) return { ...state, pendingHideAt: null };
      return { ...state, visible: false, pendingHideAt: null };
    }

    default:
      return state;
  }
}
