// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { create_audio_recorder } from '../app/src/lib/audio_recorder';

// audio_recorder.ts is otherwise browser-only (getUserMedia/MediaRecorder
// aren't available under this repo's vitest config — see that module's
// header comment), but `create_audio_recorder()` itself touches neither:
// it just returns the controller closure. Every browser API access is
// deferred to `start()`, which none of these tests call — so the
// "recorder exists but hasn't started yet" state (fix round 1,
// task-7-report.md, Finding 1) is directly testable without a DOM.

describe('audio_recorder: pre-start state (never call start())', () => {
  it('ready is false before start() is ever called', () => {
    const rec = create_audio_recorder('20260101-000000', {
      onRecordingChange: () => {},
      onNoMic: () => {}
    });
    expect(rec.ready).toBe(false);
  });

  it('now() returns 0 (a "no timebase yet" placeholder) before start()', () => {
    const rec = create_audio_recorder('20260101-000000', {
      onRecordingChange: () => {},
      onNoMic: () => {}
    });
    expect(rec.now()).toBe(0);
  });

  it('noMic is false before start() (denial hasn\'t been attempted, let alone confirmed)', () => {
    const rec = create_audio_recorder('20260101-000000', {
      onRecordingChange: () => {},
      onNoMic: () => {}
    });
    expect(rec.noMic).toBe(false);
  });
});
