// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure state machine for one fact-check's docked card (Task
// 10). Framework-free (no runes), same rationale as session_store_core.ts
// / keymap.ts's `decide_key`: the DECISIONS are what's worth getting right
// and regression-testing, kept separate from the Svelte component (`factcheck_
// card.svelte`) and from the network/SSE plumbing (`factcheck_client.ts`).
//
// Relationship to `shared/model.ts`'s `FactCheck`: this is NOT that shape.
// `FactCheck` is the durable session record app.svelte patches via
// `session_store_core.ts`'s `add_fact_check`/`set_fact_check_quick`/
// `set_fact_check_deep` as SSE events arrive — that happens regardless of
// what the user does with the floating card (a fact-check that finishes
// while nobody's watching still lands in the session and on the audio
// timeline). THIS reducer is the transient, card-only view state: it adds
// `nuance` (deliberately never persisted — see task-10-report.md /
// progress.md's T10<->T2 ruling: the FactCheck model's fields already
// "cover quick/deep/eta/contradicts", nuance is a same-request-only
// explanation, not a durable field) and `kept` (also transient — "keep"
// pins the fact-check into the flagging person's sidebar for the
// remainder of THIS session; see app.svelte's `keptFactCheckIds`).

export type FactCheckCardStatus = 'quick_pending' | 'deep_running' | 'deep_done' | 'dismissed';

export interface FactCheckQuickResult {
  text: string;
  model: string;
  ms: number;
}

export interface FactCheckDeepResult {
  text: string;
  model: string;
  ms: number;
  contradicts: boolean;
  /** One-sentence explanation from the extra contradiction-check call.
   *  Empty string when the check found no contradiction/nuance worth
   *  stating, or couldn't be parsed — never persisted (see header comment). */
  nuance: string;
}

export interface FactCheckCardState {
  id: string;
  question: string;
  status: FactCheckCardStatus;
  quick: FactCheckQuickResult | null;
  etaMs: number | null;
  deep: FactCheckDeepResult | null;
  /** True once the user has pressed "keep" — app.svelte reads this (via
   *  `keep_pressed` below) to add the id into that side's kept set; the
   *  card itself only uses it to know it should stop showing keep/dismiss
   *  as still-pending actions (see `card_is_settled`). */
  kept: boolean;
}

export type FactCheckCardAction =
  | { type: 'quick'; result: FactCheckQuickResult }
  | { type: 'deep_eta'; etaMs: number }
  | { type: 'deep'; result: FactCheckDeepResult }
  | { type: 'dismiss' }
  | { type: 'keep' };

/** A fresh card, right after the fact-check has been dispatched (before
 *  even the quick answer has arrived). */
export function init_factcheck_card(id: string, question: string): FactCheckCardState {
  return { id, question, status: 'quick_pending', quick: null, etaMs: null, deep: null, kept: false };
}

/**
 * Pure transition. `dismiss` is terminal: once a card is dismissed, every
 * later action (a quick/deep event arriving after the abort actually took
 * effect server-side, a stray double-click on keep, etc.) is a no-op —
 * dismissed never un-dismisses, and a dismissed card never re-shows a
 * result. `keep` does NOT change `status` — the card can be kept at any
 * point (mid-run or after `deep_done`); it only flips the `kept` flag, so a
 * keep pressed before the deep answer arrives lets the deep result keep
 * streaming into the (already-kept) session record without the card
 * re-opening in the floating stack.
 */
export function factcheck_card_reducer(state: FactCheckCardState, action: FactCheckCardAction): FactCheckCardState {
  if (state.status === 'dismissed') return state;

  switch (action.type) {
    case 'quick':
      return { ...state, quick: action.result, status: 'quick_pending' };
    case 'deep_eta':
      return { ...state, etaMs: action.etaMs, status: 'deep_running' };
    case 'deep':
      return { ...state, deep: action.result, status: 'deep_done' };
    case 'dismiss':
      return { ...state, status: 'dismissed' };
    case 'keep':
      return { ...state, kept: true };
    default:
      return state;
  }
}

/** True once a card no longer needs to keep occupying the docked stack's
 *  attention — dismissed outright, or kept (task-10-brief.md: "keep" is
 *  one of the two actions that resolve a card, the other being dismiss). */
export function card_is_settled(state: FactCheckCardState): boolean {
  return state.status === 'dismissed' || state.kept;
}
