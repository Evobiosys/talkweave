// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure keymap decision logic (Task 5) plus a thin DOM-binding
// wrapper. The decision logic is deliberately separated from the
// `addEventListener` plumbing so it's directly unit-testable under vitest
// (no jsdom/window in this project — see vitest.config.ts) without any DOM
// at all, matching the pattern established by session_store_core.ts and
// transcript_helpers.ts.
//
// Key map (fixed, from global-constraints.md / task-5-brief.md):
//   ArrowLeft / ArrowRight  -> set currentSpeaker to 'L' / 'R'.
//   ShiftLeft / ShiftRight  -> create a flag attributed to that side's
//                              person ('L'/'R'), targeting the latest
//                              FINAL segment spoken by the OPPOSITE person
//                              — the point the flagger is reacting to.
//   Space                   -> create a flag attributed to the *listener*
//                              (the person who is NOT currentSpeaker),
//                              targeting the latest final segment spoken
//                              by currentSpeaker.
//
// "Eligible segment" = the most recently added (last in array order) FINAL
// segment matching the required speaker exactly (including matching
// `null` against unattributed segments — see `latest_final_segment`).
// When none exists, the flag is still created with `segmentId: null` at
// the current time rather than being dropped (brief: shown in the sidebar
// as "moment @t") — an unanchored flag is a legitimate, useful thing.
//
// Speaker-null handling: when `currentSpeaker` is null, Space's *target
// segment* speaker is `currentSpeaker` verbatim (so it looks for the
// latest final *unattributed* segment — a real, valid Segment shape), and
// its *listener* (`by`) side has no meaningful "opposite" to fall back to,
// so it uses 'R' — the exact fallback task-5-brief.md states for dblclick
// claim flagging ("by = listener (non-current-speaker, else 'R')").
// `listener_for` implements that one fallback rule so both flag-creation
// paths (this file's Space handling, and transcript_view.svelte's
// dblclick handling via app.svelte) agree on a single definition rather
// than each inventing their own.
//
// Suppression while typing: `decide_key` takes `isTypingTarget` as a
// plain boolean and returns null unconditionally when true — the actual
// rule (event.target is an input/textarea/contenteditable) lives in
// `is_typing_target` below, kept DOM-duck-typed (checks `tagName`/
// `isContentEditable` structurally rather than `instanceof HTMLElement`)
// so it, too, is unit-testable with plain objects in a jsdom-less test
// environment. `bind_keymap`'s real DOM listener computes this once per
// event and, for real usability (so typing e.g. a literal space into a
// text field still works), fully early-returns before ever calling
// `decide_key` or `preventDefault` — `decide_key`'s own `isTypingTarget`
// branch exists as the pure, testable source of truth for the suppression
// *rule*, not because the real binder relies on it to reach that branch.
//
// Shift-combo guard: plain constraints ask for "flag only on plain Shift
// press without other keys" and explicitly allow "keydown of
// ShiftLeft/ShiftRight but ignore repeats, ... accept that shift-combos
// also fire unless you find a cheap guard." `ShiftPressTracker` is that
// cheap guard: it fires on *keyup* of the shift key, and only if no other
// key went down while it was held (i.e. a real Shift+X combo — including
// Shift+Arrow/Shift+Space — suppresses the flag). Repeats are filtered by
// the caller before ever calling `on_keydown`/`on_keyup`.
//
// Fix round 1 (review finding, Important): the keydown-ordering guard
// above has a gap when a modifier (Cmd/Ctrl/Alt) is already held *before*
// Shift goes down — no keydown for that modifier lands between Shift's
// own keydown and keyup (it fired earlier, or never fired at all if the
// modifier was already held when the page/listener attached), so
// `comboUsed` never gets set and a plain-looking Shift release fires a
// flag under a real Shift+Meta/Ctrl/Alt combo. Fixed by also checking
// `event.metaKey || event.ctrlKey || event.altKey` — which reflects
// modifier state at the moment of the event, not just "did we see its
// keydown" — on both the Shift keydown (`hasOtherModifier` param to
// `on_keydown`) and the Shift keyup (`on_keyup`, defense in depth for a
// modifier that became held without this tracker ever observing its own
// keydown). Also tightened: a *second* Shift key going down while the
// first is already tracked (both-shifts-held) now marks the in-progress
// press as a combo instead of silently overwriting `downCode` to the new
// key — previously the second Shift key's own keyup could still fire a
// "plain press" flag even though the other Shift was also held.

import type { Segment, Speaker } from '../../../shared/model';
import type { NewFlagInput } from './session_store_core';

export type FlagKeyCode = 'ShiftLeft' | 'ShiftRight' | 'Space';
export type ArrowKeyCode = 'ArrowLeft' | 'ArrowRight';
export type MappedKeyCode = FlagKeyCode | ArrowKeyCode;

export function is_mapped_key(code: string): code is MappedKeyCode {
  return (
    code === 'ShiftLeft' ||
    code === 'ShiftRight' ||
    code === 'Space' ||
    code === 'ArrowLeft' ||
    code === 'ArrowRight'
  );
}

export type KeymapAction =
  | { type: 'set_speaker'; speaker: Speaker }
  | { type: 'create_flag'; flag: NewFlagInput };

/** Opposite side of a definite speaker ('L' <-> 'R'). */
export function opposite(speaker: Speaker): Speaker {
  return speaker === 'L' ? 'R' : 'L';
}

/** The listener's side given the current-speaker state: opposite of
 *  `currentSpeaker` when set, else 'R' (documented fallback shared with
 *  dblclick claim flagging — see header comment). */
export function listener_for(currentSpeaker: Speaker | null): Speaker {
  return currentSpeaker === null ? 'R' : opposite(currentSpeaker);
}

/**
 * Most recently added (last in array order) FINAL segment whose `speaker`
 * matches exactly — including `null` matching unattributed segments.
 * Returns undefined when no segment qualifies.
 */
export function latest_final_segment(segments: Segment[], speaker: Speaker | null): Segment | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.final && s.speaker === speaker) return s;
  }
  return undefined;
}

export interface DecideKeyInput {
  /** `KeyboardEvent.code` — physical key, not the shift-modified character. */
  code: string;
  segments: Segment[];
  currentSpeaker: Speaker | null;
  /** Current session-elapsed seconds, used as the new flag's `t`. */
  now: number;
  /** True when focus is in an input/textarea/contenteditable — see header
   *  comment. When true, always returns null. */
  isTypingTarget: boolean;
}

/**
 * Pure decision: given a key's `code` and current session state, returns
 * the action to perform, or null for an unmapped key / suppressed focus
 * (caller does nothing further — no dispatch). All DOM concerns
 * (`preventDefault`, the shift-combo guard, `event.repeat`) live in the
 * caller (`bind_keymap` below); this function only ever decides *what* an
 * already-accepted key press means.
 */
export function decide_key(input: DecideKeyInput): KeymapAction | null {
  const { code, segments, currentSpeaker, now, isTypingTarget } = input;
  if (isTypingTarget) return null;

  if (code === 'ArrowLeft') return { type: 'set_speaker', speaker: 'L' };
  if (code === 'ArrowRight') return { type: 'set_speaker', speaker: 'R' };

  if (code === 'ShiftLeft' || code === 'ShiftRight') {
    const by: Speaker = code === 'ShiftLeft' ? 'L' : 'R';
    const target = latest_final_segment(segments, opposite(by));
    return {
      type: 'create_flag',
      flag: {
        by,
        segmentId: target?.id ?? null,
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: now
      }
    };
  }

  if (code === 'Space') {
    const by = listener_for(currentSpeaker);
    const target = latest_final_segment(segments, currentSpeaker);
    return {
      type: 'create_flag',
      flag: {
        by,
        segmentId: target?.id ?? null,
        claimText: null,
        charStart: null,
        charEnd: null,
        source: 'key',
        t: now
      }
    };
  }

  return null;
}

/**
 * True when `target` structurally looks like an input/textarea/
 * contenteditable element. Duck-typed on `tagName`/`isContentEditable`
 * rather than `instanceof HTMLElement` so this is callable with a plain
 * object in tests (no DOM global available under this project's node-
 * environment vitest config) as well as with a real `EventTarget` at
 * runtime.
 */
export function is_typing_target(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

/**
 * Tracks one held Shift key across keydown/keyup to implement the "plain
 * press only" guard described in the header comment. Caller contract:
 * only call `on_keydown`/`on_keyup` for events that already passed the
 * typing-target and `event.repeat` filters.
 */
export class ShiftPressTracker {
  private downCode: 'ShiftLeft' | 'ShiftRight' | null = null;
  private comboUsed = false;

  /**
   * Call for every accepted keydown (Shift or otherwise). `hasOtherModifier`
   * — pass `event.metaKey || event.ctrlKey || event.altKey` for a Shift
   * keydown — catches a modifier that was already held *before* Shift
   * went down (see fix-round-1 comment in the file header): such a
   * modifier's own keydown may never reach this tracker, so ordering
   * alone can't detect it.
   */
  on_keydown(code: string, hasOtherModifier = false): void {
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      if (this.downCode !== null && this.downCode !== code) {
        // The *other* Shift key is already being tracked — both-shifts-
        // held-simultaneously suppresses the in-progress press rather
        // than silently switching tracking to this new key (fix round 1,
        // Minor finding).
        this.comboUsed = true;
        return;
      }
      this.downCode = code;
      this.comboUsed = hasOtherModifier;
      return;
    }
    if (this.downCode !== null) this.comboUsed = true;
  }

  /**
   * Call for every accepted keyup. Returns the shift side to flag
   * ('ShiftLeft'/'ShiftRight') when this keyup completes a *plain* Shift
   * press (no other key went down while it was held, and no other
   * modifier is currently held — see `hasOtherModifier`), else null.
   */
  on_keyup(code: string, hasOtherModifier = false): 'ShiftLeft' | 'ShiftRight' | null {
    if (code !== this.downCode) return null;
    const fire = this.comboUsed || hasOtherModifier ? null : this.downCode;
    this.downCode = null;
    this.comboUsed = false;
    return fire;
  }
}

export interface KeymapHandlers {
  /** Read fresh on every accepted key event (segments/currentSpeaker are
   *  reactive state owned by the caller, e.g. app.svelte's SessionStore). */
  get_state: () => { segments: Segment[]; currentSpeaker: Speaker | null };
  /** Current session-elapsed seconds — see app.svelte / session_clock.ts. */
  now: () => number;
  dispatch: (action: KeymapAction) => void;
}

/**
 * Wires the pure decision logic above to real `keydown`/`keyup` listeners
 * on `target` (typically `window`). Returns an unbind function. Not
 * exercised by vitest (no jsdom in this project); verified manually via
 * headless Playwright — see task-5-report.md.
 */
export function bind_keymap(target: EventTarget, handlers: KeymapHandlers): () => void {
  const tracker = new ShiftPressTracker();

  function run(code: MappedKeyCode): void {
    const { segments, currentSpeaker } = handlers.get_state();
    const action = decide_key({
      code,
      segments,
      currentSpeaker,
      now: handlers.now(),
      isTypingTarget: false
    });
    if (action) handlers.dispatch(action);
  }

  function handle_keydown(event: Event): void {
    const kEvent = event as KeyboardEvent;
    if (is_typing_target(kEvent.target)) return;
    const code = kEvent.code;

    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      if (kEvent.repeat) return;
      tracker.on_keydown(code, kEvent.metaKey || kEvent.ctrlKey || kEvent.altKey);
      return;
    }

    // Any other key (mapped or not) feeds the combo tracker, so a
    // Shift+X combo — X being ArrowLeft/Space/anything else — suppresses
    // the plain-Shift flag on release. Must happen before the
    // `is_mapped_key` early-return below, else an unmapped key held with
    // Shift (e.g. Shift+A) would never register as a combo.
    tracker.on_keydown(code);

    if (!is_mapped_key(code)) return;

    if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Space') {
      kEvent.preventDefault();
    }
    if (kEvent.repeat) return;
    run(code);
  }

  function handle_keyup(event: Event): void {
    const kEvent = event as KeyboardEvent;
    if (is_typing_target(kEvent.target)) return;
    if (kEvent.code !== 'ShiftLeft' && kEvent.code !== 'ShiftRight') {
      // Non-shift keyup: the matching keydown already told the tracker
      // about any combo (`tracker.on_keydown` in `handle_keydown` above);
      // nothing to do here.
      return;
    }
    const fired = tracker.on_keyup(kEvent.code, kEvent.metaKey || kEvent.ctrlKey || kEvent.altKey);
    if (fired) run(fired);
  }

  target.addEventListener('keydown', handle_keydown);
  target.addEventListener('keyup', handle_keyup);
  return () => {
    target.removeEventListener('keydown', handle_keydown);
    target.removeEventListener('keyup', handle_keyup);
  };
}
