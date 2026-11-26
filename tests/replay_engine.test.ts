// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from 'vitest';
import { create_replay_engine } from '../app/src/lib/replay_engine';
import type { EngineEvent } from '../shared/engine';
import type { DemoTurn } from '../app/src/lib/fixtures/demo_conversation';

interface Captured {
  kind: 'partial' | 'segment';
  event: EngineEvent;
}

function record(engine: ReturnType<typeof create_replay_engine>): Captured[] {
  const events: Captured[] = [];
  engine.on('partial', (event) => events.push({ kind: 'partial', event }));
  engine.on('segment', (event) => events.push({ kind: 'segment', event }));
  return events;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('replay_engine: tick schedule at 1x speed', () => {
  it('ticks every 350ms, emitting a final segment on the last tick of a turn', async () => {
    vi.useFakeTimers();
    const turns: DemoTurn[] = [{ speaker: 'L', duration: 1.05, text: 'a b c' }];
    const engine = create_replay_engine({ turns });
    const events = record(engine);

    await engine.start();
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(350);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'partial', event: { final: false, speaker: 'L' } });

    await vi.advanceTimersByTimeAsync(350);
    expect(events).toHaveLength(2);
    expect(events[1].kind).toBe('partial');

    await vi.advanceTimersByTimeAsync(350);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ kind: 'segment', event: { final: true, text: 'a b c', tStart: 0 } });
    expect(events[2].event.tEnd).toBeCloseTo(1.05, 5);

    // Nothing further to play — advancing well past the fixture's end
    // must not produce more events.
    await vi.advanceTimersByTimeAsync(10000);
    expect(events).toHaveLength(3);
  });
});

describe('replay_engine: speed scaling', () => {
  it('halves the real-time tick interval at 2x speed without changing tick COUNT', async () => {
    vi.useFakeTimers();
    const turns: DemoTurn[] = [{ speaker: 'L', duration: 1.05, text: 'a b c' }];
    const engine = create_replay_engine({ turns, get_speed: () => 2 });
    const events = record(engine);

    await engine.start();
    await vi.advanceTimersByTimeAsync(175);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(175);
    expect(events).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(175);
    expect(events).toHaveLength(3);
    expect(events[2].event.final).toBe(true);
  });

  it('clamps a speed of 0 up to the 0.5x floor (not a division-by-zero/Infinity delay)', async () => {
    vi.useFakeTimers();
    const turns: DemoTurn[] = [{ speaker: 'L', duration: 0.35, text: 'hi' }];
    const engine = create_replay_engine({ turns, get_speed: () => 0 });
    const events = record(engine);

    await engine.start();
    // Clamped to 0.5x: 350 / 0.5 = 700ms, not an unreachable Infinity delay.
    await vi.advanceTimersByTimeAsync(699);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
  });

  it('clamps a speed above 8x down to the 8x ceiling', async () => {
    vi.useFakeTimers();
    const turns: DemoTurn[] = [{ speaker: 'L', duration: 0.35, text: 'hi' }];
    const engine = create_replay_engine({ turns, get_speed: () => 100 });
    const events = record(engine);

    await engine.start();
    // Clamped to 8x: 350 / 8 = 43.75ms.
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toHaveLength(1);
  });
});

describe('replay_engine: multi-turn timeline and speaker alternation', () => {
  it('starts each turn at the previous turn\'s tEnd, alternating speakers', async () => {
    vi.useFakeTimers();
    const turns: DemoTurn[] = [
      { speaker: 'L', duration: 0.35, text: 'hi' },
      { speaker: 'R', duration: 0.35, text: 'yo' }
    ];
    const engine = create_replay_engine({ turns });
    const events = record(engine);

    await engine.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({ speaker: 'L', tStart: 0, tEnd: 0.35, final: true });

    await vi.advanceTimersByTimeAsync(350);
    expect(events).toHaveLength(2);
    expect(events[1].event).toMatchObject({ speaker: 'R', tStart: 0.35, tEnd: 0.7, final: true });
  });
});

describe('replay_engine: stop()', () => {
  it('stops emitting further events once stopped, mid-turn', async () => {
    vi.useFakeTimers();
    const turns: DemoTurn[] = [{ speaker: 'L', duration: 3.5, text: 'one two three four five six seven eight nine ten' }];
    const engine = create_replay_engine({ turns });
    const events = record(engine);

    await engine.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(events).toHaveLength(1);

    engine.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(events).toHaveLength(1);
  });
});

describe('replay_engine: now()', () => {
  it('reports 0 before any tick, then the latest event tEnd as ticks arrive', async () => {
    vi.useFakeTimers();
    const turns: DemoTurn[] = [{ speaker: 'L', duration: 0.7, text: 'a b' }];
    const engine = create_replay_engine({ turns });

    expect(engine.now()).toBe(0);
    await engine.start();
    expect(engine.now()).toBe(0);

    await vi.advanceTimersByTimeAsync(350);
    expect(engine.now()).toBeGreaterThan(0);
    expect(engine.now()).toBeLessThan(0.7);

    await vi.advanceTimersByTimeAsync(350);
    expect(engine.now()).toBeCloseTo(0.7, 5);
  });
});
