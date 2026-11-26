// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure state machine for one docked "ask the conversation"
// card. Framework-free (no runes), same rationale as factcheck_reducer.ts:
// the DECISIONS are what's worth regression-testing, kept separate from
// the Svelte component (ask_card.svelte) and the network plumbing
// (ask_client.ts).
//
// Two-phase by construction, not by accident: `matches` is populated at
// CREATION time (`init_ask_card`), synchronously, from app/src/lib/
// retrieval.ts's pure token-overlap search — never from a network
// response. `modelStatus` tracks only the SEPARATE, optional model-judging
// step (POST /api/ask) layered on top. This is what makes "algorithmic
// first, AI second" a structural property of the state shape rather than
// a convention callers have to remember: a card is a complete, useful
// answer (its retrieved matches, jumpable) the instant it's created, with
// or without the model ever responding.
//
// `mode` covers all three surfaces from one shape: 'recall' ("did we talk
// about this before?"), 'contradiction' ("was this contradicted
// elsewhere?"), and 'freeform' (the user's own question, answered over
// the same retrieved shortlist). `sameTopic`/`contradicts` are only ever
// set for the modes they apply to; `modelText` is the one human-readable
// line every mode eventually produces (the same-topic reasoning sentence,
// the contradiction nuance, or the free-form answer itself).

import type { Speaker } from '../../../shared/model';

export type AskMode = 'recall' | 'contradiction' | 'freeform';

/** One retrieved segment, already resolved to the plain fields the card
 *  needs to render + jump to it — not `RetrievalMatch` itself (that type
 *  carries a full `Segment`; this is the trimmed shape that also crosses
 *  the wire to POST /api/ask, so it stays framework- and shared-model-
 *  agnostic on that side too). */
export interface AskMatch {
  segmentId: string;
  speaker: Speaker | null;
  tStart: number;
  text: string;
  score: number;
}

export type AskModelStatus = 'idle' | 'running' | 'done' | 'unavailable' | 'dismissed';

export interface AskCardState {
  id: string;
  mode: AskMode;
  /** The highlighted passage (recall/contradiction) or the user's own
   *  free-form question — whichever this card was dispatched with. */
  query: string;
  /** Always present from creation — see header comment. Empty array is a
   *  legitimate, meaningful result ("nothing like this was said before"),
   *  not a loading state. */
  matches: AskMatch[];
  modelStatus: AskModelStatus;
  modelText: string | null;
  /** Set only for `mode: 'recall'`, once `modelStatus` is `'done'`. */
  sameTopic: boolean | null;
  /** Set only for `mode: 'contradiction'`, once `modelStatus` is `'done'`. */
  contradicts: boolean | null;
}

export type AskCardAction =
  | { type: 'model_running' }
  | { type: 'model_result'; text: string; sameTopic?: boolean; contradicts?: boolean }
  | { type: 'model_unavailable' }
  | { type: 'dismiss' };

/** A fresh card, retrieval already run — see header comment on why
 *  `matches` is a constructor argument, not something a later action
 *  populates. */
export function init_ask_card(id: string, mode: AskMode, query: string, matches: AskMatch[]): AskCardState {
  return { id, mode, query, matches, modelStatus: 'idle', modelText: null, sameTopic: null, contradicts: null };
}

/**
 * Pure transition. `dismiss` is terminal (same "never un-dismisses" rule
 * as factcheck_card_reducer): a model response arriving after the card's
 * own abort() already fired is a no-op, never resurrecting a dismissed
 * card's content.
 */
export function ask_card_reducer(state: AskCardState, action: AskCardAction): AskCardState {
  if (state.modelStatus === 'dismissed') return state;

  switch (action.type) {
    case 'model_running':
      return { ...state, modelStatus: 'running' };
    case 'model_result':
      return {
        ...state,
        modelStatus: 'done',
        modelText: action.text,
        sameTopic: action.sameTopic ?? state.sameTopic,
        contradicts: action.contradicts ?? state.contradicts
      };
    case 'model_unavailable':
      return { ...state, modelStatus: 'unavailable' };
    case 'dismiss':
      return { ...state, modelStatus: 'dismissed' };
    default:
      return state;
  }
}
