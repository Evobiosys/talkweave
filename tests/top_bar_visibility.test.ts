// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  init_top_bar_state,
  top_bar_reducer,
  top_bar_visible,
  type TopBarState
} from '../app/src/lib/top_bar_visibility';

const GRACE = 300;

describe('top_bar_visibility: edge-hover reveal', () => {
  it('is hidden in the initial state', () => {
    expect(top_bar_visible(init_top_bar_state())).toBe(false);
  });

  it('edge_hover reveals the bar', () => {
    const state = top_bar_reducer(init_top_bar_state(), { type: 'edge_hover' });
    expect(top_bar_visible(state)).toBe(true);
  });

  it('edge_hover cancels any deadline already scheduled from a previous visit', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    state = top_bar_reducer(state, { type: 'pointer_leave', now: 1000, graceMs: GRACE });
    expect(state.pendingHideAt).toBe(1300);
    state = top_bar_reducer(state, { type: 'edge_hover' });
    expect(state.pendingHideAt).toBeNull();
    expect(top_bar_visible(state)).toBe(true);
  });
});

describe('top_bar_visibility: inside-bar hold (the Task 14 bug)', () => {
  it('pointer_enter holds the bar open even though clientY would be well past the old hide threshold', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    expect(top_bar_visible(state)).toBe(true);
    expect(state.overHeader).toBe(true);
    // No clientY concept exists anymore — nothing about being "far down
    // the screen" can retreat the bar while overHeader is true.
  });

  it('pointer_outside is a no-op while the pointer is over the header', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    state = top_bar_reducer(state, { type: 'pointer_outside', now: 1000, graceMs: GRACE });
    expect(state.pendingHideAt).toBeNull();
    expect(top_bar_visible(state)).toBe(true);
  });

  it('moving between fields inside the bar (repeated pointer_enter) never schedules a hide', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    for (let i = 0; i < 5; i++) {
      state = top_bar_reducer(state, { type: 'pointer_enter' });
    }
    expect(state.pendingHideAt).toBeNull();
    expect(top_bar_visible(state)).toBe(true);
  });
});

describe('top_bar_visibility: leave -> hide after grace', () => {
  function reveal_and_enter(): TopBarState {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    return state;
  }

  it('pointer_leave schedules a hide graceMs in the future, not immediately', () => {
    let state = reveal_and_enter();
    state = top_bar_reducer(state, { type: 'pointer_leave', now: 1000, graceMs: GRACE });
    expect(top_bar_visible(state)).toBe(true);
    expect(state.pendingHideAt).toBe(1300);
  });

  it('a tick before the deadline does not hide', () => {
    let state = reveal_and_enter();
    state = top_bar_reducer(state, { type: 'pointer_leave', now: 1000, graceMs: GRACE });
    state = top_bar_reducer(state, { type: 'tick', now: 1299 });
    expect(top_bar_visible(state)).toBe(true);
  });

  it('a tick at/after the deadline hides', () => {
    let state = reveal_and_enter();
    state = top_bar_reducer(state, { type: 'pointer_leave', now: 1000, graceMs: GRACE });
    state = top_bar_reducer(state, { type: 'tick', now: 1300 });
    expect(top_bar_visible(state)).toBe(false);
    expect(state.pendingHideAt).toBeNull();
  });

  it('re-entering before the deadline cancels the hide (no flicker)', () => {
    let state = reveal_and_enter();
    state = top_bar_reducer(state, { type: 'pointer_leave', now: 1000, graceMs: GRACE });
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    state = top_bar_reducer(state, { type: 'tick', now: 1300 });
    expect(top_bar_visible(state)).toBe(true);
  });

  it('regression guard: pointer_outside hides after grace even with no enter/leave pair ever occurring (fast flick past the header)', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    state = top_bar_reducer(state, { type: 'pointer_outside', now: 1000, graceMs: GRACE });
    expect(top_bar_visible(state)).toBe(true);
    state = top_bar_reducer(state, { type: 'tick', now: 1300 });
    expect(top_bar_visible(state)).toBe(false);
  });

  it('repeated pointer_outside events do not push the deadline further out than the first one', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    state = top_bar_reducer(state, { type: 'pointer_outside', now: 1000, graceMs: GRACE });
    state = top_bar_reducer(state, { type: 'pointer_outside', now: 1200, graceMs: GRACE });
    state = top_bar_reducer(state, { type: 'pointer_outside', now: 1290, graceMs: GRACE });
    expect(state.pendingHideAt).toBe(1300);
  });
});

describe('top_bar_visibility: focus hold', () => {
  it('focus_in holds the bar open with the pointer nowhere near it', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'focus_in' });
    expect(top_bar_visible(state)).toBe(true);
    expect(state.overHeader).toBe(false);
  });

  it('focus_out with the pointer elsewhere schedules a hide that fires after grace', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'focus_in' });
    state = top_bar_reducer(state, { type: 'focus_out', now: 1000, graceMs: GRACE });
    expect(top_bar_visible(state)).toBe(true);
    expect(state.pendingHideAt).toBe(1300);
    state = top_bar_reducer(state, { type: 'tick', now: 1300 });
    expect(top_bar_visible(state)).toBe(false);
  });

  it('focus_out immediately followed by focus_in (tabbing/clicking field-to-field) never schedules a hide that fires', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'focus_in' });
    state = top_bar_reducer(state, { type: 'focus_out', now: 1000, graceMs: GRACE });
    state = top_bar_reducer(state, { type: 'focus_in' });
    expect(state.pendingHideAt).toBeNull();
    state = top_bar_reducer(state, { type: 'tick', now: 1300 });
    expect(top_bar_visible(state)).toBe(true);
  });

  it('focus_out while the pointer is still over the header does not schedule a hide', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'edge_hover' });
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    state = top_bar_reducer(state, { type: 'focus_in' });
    state = top_bar_reducer(state, { type: 'focus_out', now: 1000, graceMs: GRACE });
    expect(state.pendingHideAt).toBeNull();
    expect(top_bar_visible(state)).toBe(true);
  });

  it('losing focus but staying over the header keeps the bar open with no pending deadline at all', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    state = top_bar_reducer(state, { type: 'focus_in' });
    state = top_bar_reducer(state, { type: 'focus_out', now: 1000, graceMs: GRACE });
    expect(state.pendingHideAt).toBeNull();
    state = top_bar_reducer(state, { type: 'tick', now: 1300 });
    expect(top_bar_visible(state)).toBe(true);
  });
});

describe('top_bar_visibility: comma pin/unpin', () => {
  it('toggle_pin opens the bar with no pointer/focus involvement at all', () => {
    const state = top_bar_reducer(init_top_bar_state(), { type: 'toggle_pin' });
    expect(state.pinned).toBe(true);
    expect(top_bar_visible(state)).toBe(true);
  });

  it('toggle_pin again closes it immediately when nothing else holds it open', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'toggle_pin' });
    state = top_bar_reducer(state, { type: 'toggle_pin' });
    expect(top_bar_visible(state)).toBe(false);
  });

  it('unpinning while the pointer is over the header does not hide it', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'toggle_pin' });
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    state = top_bar_reducer(state, { type: 'toggle_pin' });
    expect(top_bar_visible(state)).toBe(true);
  });

  it('unpinning while focus is inside the bar does not hide it', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'toggle_pin' });
    state = top_bar_reducer(state, { type: 'focus_in' });
    state = top_bar_reducer(state, { type: 'toggle_pin' });
    expect(top_bar_visible(state)).toBe(true);
  });

  it('pinning while a hide is already pending cancels it, same as edge_hover', () => {
    let state = init_top_bar_state();
    state = top_bar_reducer(state, { type: 'pointer_enter' });
    state = top_bar_reducer(state, { type: 'pointer_leave', now: 1000, graceMs: GRACE });
    expect(state.pendingHideAt).toBe(1300);
    state = top_bar_reducer(state, { type: 'toggle_pin' });
    expect(state.pendingHideAt).toBeNull();
    expect(top_bar_visible(state)).toBe(true);
  });
});
