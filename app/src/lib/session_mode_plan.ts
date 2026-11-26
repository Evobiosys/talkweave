// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — Task 8 fix round 1: the pure gating decision for
// `app.svelte`'s `handle_session_ready`, extracted out of that function so
// the demo/live/resume x recorder/engine matrix is unit-testable without a
// Svelte component (Important 2 of the review — this is exactly where both
// fix-round bugs lived, unexercised by any test).
//
// Two bugs this function's shape exists to make structurally impossible to
// reintroduce:
//
// 1. (Critical) A "live session" must NEVER get `ReplayEngine`. The
//    original code routed `mode === 'demo' || settingsStore.settings.engine
//    === 'replay'` into `create_replay_engine` — and since
//    `default_settings()` (settings_store_core.ts) defaults `engine` to
//    `'replay'` and the mic option is unconditionally disabled (nobody can
//    ever select `'mic'` through the UI), EVERY live session played the
//    scripted demo fixture over real recorded audio, and `current_t()`'s
//    `if (replayNow) return replayNow();` branch put every flag/note on the
//    fixture's timeline instead of the recorder's. `startReplay` below is
//    `true` for `'demo'` ONLY — `settingsEngine` is accepted (per the
//    review's suggested signature) but not currently consulted for `'live'`,
//    since `mic_engine.ts` is a no-op placeholder either way: a live session
//    in v0.1 honestly produces NO engine transcript at all, regardless of
//    which engine is selected in settings. Once a real streaming mic engine
//    exists (v0.2), `'live'` is the one branch that will start reading
//    `settingsEngine` to decide between it and nothing.
//
// 2. (Important 1) Reopening ANY past session — most sharply, an old demo
//    session, whose `audioFile` stays null forever since demo replay never
//    records audio, making it indistinguishable from a fresh 'live' session
//    by `audioFile` alone — must never auto-start a real audio recorder.
//    `startRecorder` is `true` for `'live'` ONLY, never `'resume'`, even
//    when the resumed session's `audioFile` is still null (an interrupted
//    real live session). The review's ruling: resume is fundamentally
//    review, recording only ever starts for a freshly-chosen live session;
//    a persisted "this was a live session" marker would be a session-format
//    change and is explicitly out of scope.
//
// `noMicChip`/`replayClock` are the two derived UI/timebase facts that
// follow directly from the above, once known: `'demo'` and `'resume'` both
// never run a recorder, so both force the "no mic" chip (audio_bar.svelte's
// honest "no audio recorded" treatment) rather than the misleading
// pulsing "● rec" a `false` would show; only `'demo'` has a fixture
// timeline for `current_t()` to prefer over the recorder/wall-clock
// fallback chain (app.svelte's `current_t()`).
//
// v0.2 (DEVLOG/v02-live-transcription_of-talkweave_handover.md): a third
// parameter, `micReady` (app.svelte's `mic_ready(whisperStatus)` — BOTH
// the whisper-cli binary AND the model file present, not just the binary),
// now decides a new `startMic` field. `settingsEngine` finally gets
// consulted for `'live'` (the v0.1 header comment above named this exact
// moment as deferred to v0.2, once a real mic engine existed): a live
// session starts the real `mic_engine.ts` iff the user selected 'mic' AND
// whisper is actually ready — otherwise it behaves exactly like v0.1's
// live session (no engine, empty transcript), which is precisely the
// handover's step 6 graceful-degradation requirement ("a live session
// with mic engine selected but whisper unavailable should behave like
// v0.1's live session"). `startRecorder` is UNCHANGED by any of this —
// the real audio *recording* (webm sidecar, Task 7) stays independent of
// which transcription engine (if any) is running, per the handover's
// explicit instruction not to couple the two.
//
// `startReplay` and `startMic` are mutually exclusive with each other in
// every branch below (never both true) — `'demo'` only ever starts
// replay, `'live'` only ever starts mic (or neither), `'resume'` starts
// neither.

import type { Engine } from './settings_store_core';
import type { SessionStartMode } from './session_start_mode';

export interface SessionModePlan {
  /** Whether `handle_session_ready` should call `create_audio_recorder`. */
  startRecorder: boolean;
  /** Whether it should call `create_replay_engine` and wire the bridge. */
  startReplay: boolean;
  /** v0.2: whether it should call `create_mic_engine` and wire the bridge. */
  startMic: boolean;
  /** Whether `noMic` should be forced `true` up front (no recorder exists
   *  to ever flip it via `onNoMic`), rather than left `false` for a real
   *  recorder's callback to decide dynamically. */
  noMicChip: boolean;
  /** Whether `current_t()` should prefer the engine's own fixture-time
   *  clock over the recorder/wall-clock fallback chain. */
  replayClock: boolean;
}

export function session_mode_plan(mode: SessionStartMode, settingsEngine: Engine, micReady: boolean): SessionModePlan {
  if (mode === 'demo') {
    return { startRecorder: false, startReplay: true, startMic: false, noMicChip: true, replayClock: true };
  }
  if (mode === 'resume') {
    return { startRecorder: false, startReplay: false, startMic: false, noMicChip: true, replayClock: false };
  }
  // mode === 'live'. Recording always starts; the mic ENGINE only starts
  // when both the user picked it AND whisper is actually usable — every
  // other combination (settingsEngine === 'replay', or 'mic' selected but
  // whisper not ready) is the honest v0.1 "no engine, empty transcript"
  // behavior.
  const startMic = settingsEngine === 'mic' && micReady;
  return { startRecorder: true, startReplay: false, startMic, noMicChip: false, replayClock: false };
}
