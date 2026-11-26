// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { create_autosave_controller } from '../app/src/lib/autosave';

const DEBOUNCE_MS = 2000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('autosave: debounce behavior', () => {
  it('does not save before the debounce window elapses', () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS);

    autosave.notify();
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);

    expect(save).not.toHaveBeenCalled();
  });

  it('saves exactly once after the debounce window elapses', () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS);

    autosave.notify();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('collapses several rapid notifies (simulated mutations) into a single save at t+debounce', () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS);

    autosave.notify();
    vi.advanceTimersByTime(500);
    autosave.notify();
    vi.advanceTimersByTime(500);
    autosave.notify();

    // Still well within the debounce window of the last notify.
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves the value captured at fire time (proves the save callback sees the latest state)', () => {
    let capturedBody: string | null = null;
    let liveText = 'first';
    const autosave = create_autosave_controller(() => {
      capturedBody = liveText;
    }, DEBOUNCE_MS);

    autosave.notify();
    liveText = 'second';
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(capturedBody).toBe('second');
  });

  it('cancel() prevents a pending save from firing', () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS);

    autosave.notify();
    autosave.cancel();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(save).not.toHaveBeenCalled();
  });

  it('flush() runs the save immediately without waiting for the debounce window', async () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS);

    autosave.notify();
    await autosave.flush();

    expect(save).toHaveBeenCalledTimes(1);

    // The pending debounce timer was cancelled by flush(), so advancing
    // past the original window must not trigger a second save.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('autosave: maxWait ceiling (fix round 2 — starvation under continuous notify())', () => {
  const MAX_WAIT_MS = 10000;
  const TICK_MS = 350; // ReplayEngine's real partial cadence at 1x speed.

  it('a single notify() still saves at debounceMs, well under maxWaitMs (maxWait never fires first)', () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS, MAX_WAIT_MS);

    autosave.notify();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(save).toHaveBeenCalledTimes(1);

    // No leftover maxWait timer firing a spurious second save later.
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('guarantees a save at maxWaitMs even under continuous notify() ticks well under debounceMs', async () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS, MAX_WAIT_MS);

    let elapsed = 0;
    const saveTimestamps: number[] = [];

    autosave.notify();
    while (elapsed < 30000) {
      await vi.advanceTimersByTimeAsync(TICK_MS);
      elapsed += TICK_MS;
      if (save.mock.calls.length > saveTimestamps.length) saveTimestamps.push(elapsed);
      autosave.notify();
    }

    // At least two saves fired during 30s of continuous, sub-debounce-
    // interval notifying — proof this isn't just a single end-of-burst
    // save (the pre-fix behavior: zero saves until notify() stopped).
    expect(saveTimestamps.length).toBeGreaterThanOrEqual(2);

    // The first save landed at ~maxWaitMs, not at debounceMs (continuous
    // notifies keep resetting the settle window, so it never gets a
    // chance to fire) and not at the very end of the 30s burst.
    expect(saveTimestamps[0]).toBeGreaterThanOrEqual(MAX_WAIT_MS);
    expect(saveTimestamps[0]).toBeLessThan(MAX_WAIT_MS + TICK_MS * 2);

    // Successive saves land roughly maxWaitMs apart, not immediately back
    // to back and not only once at the very end.
    const gap = saveTimestamps[1] - saveTimestamps[0];
    expect(gap).toBeGreaterThanOrEqual(MAX_WAIT_MS);
    expect(gap).toBeLessThan(MAX_WAIT_MS + TICK_MS * 2);
  });

  it('cancel() clears both the settle and maxWait timers', () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS, MAX_WAIT_MS);

    autosave.notify();
    autosave.cancel();
    vi.advanceTimersByTime(MAX_WAIT_MS);

    expect(save).not.toHaveBeenCalled();
  });

  it('flush() clears both timers, so a stale maxWait timer never double-fires afterward', async () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS, MAX_WAIT_MS);

    // Continuous notifies (like a live ReplayEngine burst), stopped just
    // before the maxWait ceiling would have fired on its own.
    let elapsed = 0;
    autosave.notify();
    while (elapsed < MAX_WAIT_MS - 1000) {
      await vi.advanceTimersByTimeAsync(TICK_MS);
      elapsed += TICK_MS;
      autosave.notify();
    }
    expect(save).not.toHaveBeenCalled();

    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // Nothing left pending from the flushed burst — in particular, no
    // stale maxWait timer firing a spurious second save once we pass
    // where it would originally have fired.
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);

    // The controller still works normally afterward: a fresh single
    // notify() saves once, at debounceMs, same as any other lone notify.
    autosave.notify();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a save via the settle debounce also clears the maxWait timer, so a later burst starts fresh', () => {
    const save = vi.fn();
    const autosave = create_autosave_controller(save, DEBOUNCE_MS, MAX_WAIT_MS);

    autosave.notify();
    vi.advanceTimersByTime(DEBOUNCE_MS); // settles normally, well under maxWait
    expect(save).toHaveBeenCalledTimes(1);

    // A second, independent burst behaves identically to the first — no
    // leftover state from the previous (already-cleared) maxWait timer.
    autosave.notify();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(2);

    // And nothing extra fires at the old burst's would-be maxWait mark.
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
