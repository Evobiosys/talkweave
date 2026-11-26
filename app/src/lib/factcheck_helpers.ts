// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure helpers for the docked fact-check card stack (Task 10).
// Framework-free, same rationale as flag_helpers.ts.

import type { Flag, Speaker } from '../../../shared/model';
import type { FactCheckCardState } from './factcheck_reducer';
import { listener_for } from './keymap';

/**
 * task-10-brief.md: "Multiple cards stack (max 2 visible, older collapse)."
 * A dismissed card is always collapsed regardless of recency — "dismiss
 * (abort+collapse)" is explicit about that pairing. Among the rest, the
 * `max` most RECENTLY CREATED (assumes `cards` is given oldest-first,
 * i.e. creation order — the order app.svelte naturally appends new cards
 * in) stay expanded; anything older than that collapses as newer cards
 * arrive, same rhythm as side_panel.svelte's recency tiers. `kept` is
 * deliberately NOT special-cased here: task-10-brief.md never says keeping
 * a card collapses it early, only dismissing does — a kept card simply
 * ages out of the "2 most recent" window like any other.
 */
export function expanded_card_ids(cards: FactCheckCardState[], max: number = 2): Set<string> {
  const eligible = cards.filter((c) => c.status !== 'dismissed');
  const recent = eligible.slice(-max);
  return new Set(recent.map((c) => c.id));
}

export interface AttributionInput {
  /** True only when `F` resolved a real, usable transcript highlight
   *  (app.svelte's `selectionPrefill !== null`) — distinct from
   *  `selectionSpeaker` being null, which can happen even WITH a
   *  highlight (see that field's own case below). When false, this
   *  falls through to the pre-existing flag-based rule unchanged. */
  hasSelection: boolean;
  /** The speaker resolved from the highlighted DOM selection at the
   *  moment `F` was pressed (transcript_view.svelte's `resolve_
   *  selection`, via `speaker_for_segment`) — `null` when the highlight
   *  spans no single identifiable segment, OR when it resolves to
   *  exactly one segment whose OWN `speaker` is itself null (an
   *  unattributed transcript passage, a real and legitimate state per
   *  engine_bridge.ts/shared/model.ts, not a resolution failure). */
  selectionSpeaker: Speaker | null;
  latestFlag: Flag | null;
  currentSpeaker: Speaker | null;
}

/**
 * Who a dispatched fact-check should be attributed to (`FactCheck.by`).
 *
 * Fixes the attribution bug the handover names: `by` used to come from
 * `latest_flag` alone regardless of whether the prompt's text was the
 * flag's own excerpt or an unrelated highlighted passage — so a kept
 * check could pin into a sidebar belonging to someone who never said the
 * highlighted words. Now: a highlight that resolves to a real speaker
 * wins outright (`selectionSpeaker`); a highlight that resolves to no
 * speaker at all — either it spans no single segment, or that segment is
 * itself unattributed — falls to `listener_for(currentSpeaker)`, NOT to
 * `latestFlag`. `latestFlag.by` names whoever most recently reacted to
 * something ELSE; attributing an unrelated highlight to them would be
 * the exact same false attribution this function exists to fix, just
 * narrowed to the unattributed-passage case instead of eliminated.
 * `latestFlag` is only ever consulted when there was no selection to
 * begin with (`F` pressed with no highlight, prefilling from the latest
 * flag itself) — the one case where "the flag's own side" IS the
 * honestly correct attribution, since the pre-fill text and the flag are
 * then one and the same thing.
 */
export function attribution_for(input: AttributionInput): Speaker {
  if (input.hasSelection) {
    return input.selectionSpeaker ?? listener_for(input.currentSpeaker);
  }
  return input.latestFlag ? input.latestFlag.by : listener_for(input.currentSpeaker);
}
