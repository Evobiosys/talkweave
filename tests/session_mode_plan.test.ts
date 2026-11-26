// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { session_mode_plan } from '../app/src/lib/session_mode_plan';
import type { SessionStartMode } from '../app/src/lib/session_start_mode';
import type { Engine } from '../app/src/lib/settings_store_core';

const MODES: SessionStartMode[] = ['demo', 'live', 'resume'];
const ENGINES: Engine[] = ['replay', 'mic'];
const MIC_READY: boolean[] = [true, false];

describe('session_mode_plan: full demo/live/resume x replay/mic x micReady matrix', () => {
  it('demo always starts replay, never the recorder, never mic, and always uses the fixture clock — regardless of engine/micReady', () => {
    for (const settingsEngine of ENGINES) {
      for (const micReady of MIC_READY) {
        const plan = session_mode_plan('demo', settingsEngine, micReady);
        expect(plan).toEqual({ startRecorder: false, startReplay: true, startMic: false, noMicChip: true, replayClock: true });
      }
    }
  });

  it('resume never starts the recorder, replay, or mic — regardless of engine/micReady', () => {
    for (const settingsEngine of ENGINES) {
      for (const micReady of MIC_READY) {
        const plan = session_mode_plan('resume', settingsEngine, micReady);
        expect(plan).toEqual({ startRecorder: false, startReplay: false, startMic: false, noMicChip: true, replayClock: false });
      }
    }
  });

  it('live always starts the recorder and NEVER starts replay — the original critical regression this fixes — regardless of engine/micReady', () => {
    for (const settingsEngine of ENGINES) {
      for (const micReady of MIC_READY) {
        const plan = session_mode_plan('live', settingsEngine, micReady);
        expect(plan.startRecorder).toBe(true);
        expect(plan.startReplay).toBe(false);
        expect(plan.noMicChip).toBe(false);
        expect(plan.replayClock).toBe(false);
      }
    }
  });

  it('v0.2: live starts the real mic engine ONLY when engine=mic AND micReady — every other live combination stays engine-less (v0.1 behavior)', () => {
    expect(session_mode_plan('live', 'mic', true).startMic).toBe(true);
    expect(session_mode_plan('live', 'mic', false).startMic).toBe(false);
    expect(session_mode_plan('live', 'replay', true).startMic).toBe(false);
    expect(session_mode_plan('live', 'replay', false).startMic).toBe(false);
  });

  it('v0.2 step 6 graceful degradation: mic selected but whisper unavailable behaves exactly like v0.1 live (recorder on, no engine at all)', () => {
    const plan = session_mode_plan('live', 'mic', false);
    expect(plan.startRecorder).toBe(true);
    expect(plan.startReplay).toBe(false);
    expect(plan.startMic).toBe(false);
  });

  it('startReplay and startMic are never both true, for any mode/engine/micReady combination', () => {
    for (const mode of MODES) {
      for (const settingsEngine of ENGINES) {
        for (const micReady of MIC_READY) {
          const plan = session_mode_plan(mode, settingsEngine, micReady);
          expect(plan.startReplay && plan.startMic).toBe(false);
        }
      }
    }
  });

  it('noMicChip is forced true whenever no recorder is started (demo, resume), false only when a real recorder is starting (live)', () => {
    for (const mode of MODES) {
      for (const settingsEngine of ENGINES) {
        for (const micReady of MIC_READY) {
          const plan = session_mode_plan(mode, settingsEngine, micReady);
          expect(plan.noMicChip).toBe(!plan.startRecorder);
        }
      }
    }
  });

  it('replayClock is true only when startReplay is true', () => {
    for (const mode of MODES) {
      for (const settingsEngine of ENGINES) {
        for (const micReady of MIC_READY) {
          const plan = session_mode_plan(mode, settingsEngine, micReady);
          expect(plan.replayClock).toBe(plan.startReplay);
        }
      }
    }
  });
});
