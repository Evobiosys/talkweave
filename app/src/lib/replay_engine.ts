// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — TranscriptionEngine (shared/engine.ts) that plays back
// fixtures/demo_conversation.ts on a scripted timeline instead of a real
// mic/whisper pipeline (Task 8's "demo conversation" entry point).
//
// Timeline: turn N's `tStart` is turn N-1's `tEnd` (no gap) — a running sum
// of `duration`, computed here rather than stored in the fixture (see that
// file's header comment).
//
// Emission: each turn ticks every `PARTIAL_CADENCE_MS` (350ms, per
// task-8-brief.md), scaled by the current replay speed, growing the
// emitted text by one more proportional word-group per tick and firing
// `'partial'` (`final: false`) — except the last tick of a turn, which
// fires `'segment'` once with the turn's full text (`final: true`). A
// turn's own `duration` therefore elapses over `tickCount = round(duration
// * 1000 / 350)` ticks; the final `segment` for a turn lands after that
// many ticks of (possibly sped-up) real time, not at some other instant —
// see replay_engine.test.ts, which asserts exactly this tick schedule
// rather than an idealized "final segment at wall-clock tStart+duration".
//
// Speed: read fresh via `get_speed()` on every scheduled tick (not once at
// start()), so a live change to Task 6's settings.replaySpeed while replay
// is already running takes effect on the very next tick rather than
// requiring a restart. Clamped to [0.5, 8] per task-8-brief.md's stated
// range — this also guards against a stray 0 (division by zero -> an
// infinite per-tick delay) or a NaN from a not-yet-validated settings
// value.
//
// Timebase seam: unlike shared/engine.ts's plain `TranscriptionEngine`
// interface (no `now()` — a real streaming engine has no equivalent
// concept), the concrete object this factory returns also exposes `now()`:
// the engine's own current position on the fixture's cumulative-duration
// timeline. app.svelte's `current_t()` reads this in preference to the
// wall-clock/audio-recorder fallback chain while a replay engine is
// driving the session — see task-8-report.md's "Timebase" note for why
// that reconciliation is necessary (a demo running at 8x speed reaches
// fixture-second 180 in about 22 real seconds; without this, a flag
// created mid-demo would be stamped with the wrong number entirely).
//
// Kept pure otherwise: never touches Session/SessionStore. engine_bridge.ts
// is the one place a `partial`/`segment` event becomes a store mutation.

import type { EngineEvent, EngineEventName, TranscriptionEngine } from '../../../shared/engine';
import { DEMO_CONVERSATION, type DemoTurn } from './fixtures/demo_conversation';

const PARTIAL_CADENCE_MS = 350;
const MIN_SPEED = 0.5;
const MAX_SPEED = 8;

export interface ReplayEngine extends TranscriptionEngine {
  /** Seconds elapsed on the fixture's own cumulative-duration timeline —
   *  see module header's "Timebase seam". 0 before the first tick fires. */
  now(): number;
}

export interface ReplayEngineOptions {
  /** Defaults to the real demo fixture; overridable so tests can drive a
   *  small, fast, hand-picked timeline instead of the full ~36-turn one. */
  turns?: DemoTurn[];
  /** Read on every scheduled tick — see module header's "Speed" note.
   *  Defaults to a fixed 1x for callers (tests, or any future caller that
   *  doesn't care about live settings) that don't pass one. */
  get_speed?: () => number;
}

function clamp_speed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

export function create_replay_engine(options: ReplayEngineOptions = {}): ReplayEngine {
  const turns = options.turns ?? DEMO_CONVERSATION;
  const get_speed = options.get_speed ?? (() => 1);

  const listeners: Record<EngineEventName, Array<(event: EngineEvent) => void>> = {
    partial: [],
    segment: []
  };

  let stopped = true;
  let currentT = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: (() => void) | null = null;

  /** Resolves after `ms` real milliseconds, or immediately once `stop()`
   *  cancels it — see module header on why the promise must always settle
   *  rather than being left dangling on stop (a suspended `await` inside
   *  `play_turn` would otherwise never unwind). */
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      pendingResolve = resolve;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        pendingResolve = null;
        resolve();
      }, ms);
    });
  }

  function emit(kind: EngineEventName, event: EngineEvent): void {
    currentT = event.tEnd;
    for (const cb of listeners[kind]) cb(event);
  }

  async function play_turn(turn: DemoTurn, tStart: number): Promise<void> {
    const tEnd = tStart + turn.duration;
    const words = turn.text.split(/\s+/).filter((w) => w.length > 0);
    const tickCount = Math.max(1, Math.round((turn.duration * 1000) / PARTIAL_CADENCE_MS));

    for (let tick = 1; tick <= tickCount; tick++) {
      if (stopped) return;
      await wait(PARTIAL_CADENCE_MS / clamp_speed(get_speed()));
      if (stopped) return;

      const isFinalTick = tick === tickCount;
      const wordCount = isFinalTick ? words.length : Math.min(words.length, Math.round((words.length * tick) / tickCount));
      const progressT = tStart + (turn.duration * tick) / tickCount;

      const event: EngineEvent = {
        speaker: turn.speaker,
        tStart,
        tEnd: isFinalTick ? tEnd : progressT,
        text: words.slice(0, wordCount).join(' '),
        final: isFinalTick
      };

      emit(isFinalTick ? 'segment' : 'partial', event);
    }
  }

  async function play_all(): Promise<void> {
    let tStart = 0;
    for (const turn of turns) {
      if (stopped) return;
      await play_turn(turn, tStart);
      tStart += turn.duration;
    }
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      currentT = 0;
      void play_all();
    },
    stop(): void {
      stopped = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (pendingResolve !== null) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve();
      }
    },
    on(ev: EngineEventName, cb: (event: EngineEvent) => void): void {
      listeners[ev].push(cb);
    },
    now(): number {
      return currentT;
    }
  };
}
