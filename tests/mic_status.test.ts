// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { mic_status_text, type MicStatusInputs } from '../app/src/lib/mic_status';

function inputs(overrides: Partial<MicStatusInputs> = {}): MicStatusInputs {
  return {
    audioStarted: false,
    hasSegments: false,
    pendingAudio: false,
    lastDecodeMs: null,
    stalled: false,
    ...overrides
  };
}

describe('mic_status_text: waiting for audio vs audio arriving', () => {
  it('says precisely "waiting for audio" before any audio has ever been captured', () => {
    expect(mic_status_text(inputs())).toBe('waiting for audio…');
  });

  it('switches to an "audio arriving" clause the instant audioStarted flips true', () => {
    const text = mic_status_text(inputs({ audioStarted: true }));
    expect(text).toContain('audio arriving');
  });
});

describe('mic_status_text: "nothing transcribed yet" is said precisely, not "listening"', () => {
  it('says exactly that once audio is arriving but no segment exists yet', () => {
    const text = mic_status_text(inputs({ audioStarted: true, hasSegments: false }));
    expect(text).toContain('nothing transcribed yet');
    expect(text).not.toContain('listening');
  });

  it('adds "first pass in progress" when audio is pending (a window is being transcribed right now)', () => {
    const text = mic_status_text(inputs({ audioStarted: true, hasSegments: false, pendingAudio: true }));
    expect(text).toBe('audio arriving — nothing transcribed yet, first pass in progress');
  });

  it('includes a known decode duration even while still segment-less (a decode ran but found nothing)', () => {
    const text = mic_status_text(inputs({ audioStarted: true, hasSegments: false, pendingAudio: false, lastDecodeMs: 900 }));
    expect(text).toBe('audio arriving — nothing transcribed yet (last decode 0.9s)');
  });
});

describe('mic_status_text: once segments exist, always "transcribing…" — never a flickering "caught up"', () => {
  // Regression for a real bug caught by headless-Playwright measurement,
  // not by any unit test (a pure function over scalars can't catch a
  // TEMPORAL flicker): `pendingAudio` genuinely does flip false for a
  // sub-100ms gap after every single SSE event during live capture
  // (`ScriptProcessorNode.onaudioprocess` fires roughly every 85-100ms,
  // `tick()`'s cadence is 900-1500ms), so a text that alternated on it
  // once segments exist would visibly strobe about once a second. See
  // mic_status.ts's header comment on `pendingAudio` for the full
  // reasoning — the fix is simply to never branch on it here.
  it('reports "transcribing…" regardless of pendingAudio', () => {
    expect(mic_status_text(inputs({ audioStarted: true, hasSegments: true, pendingAudio: true }))).toBe('transcribing…');
    expect(mic_status_text(inputs({ audioStarted: true, hasSegments: true, pendingAudio: false }))).toBe('transcribing…');
  });

  it('appends the measured last-decode duration, so a slow model reads as slow', () => {
    const text = mic_status_text(inputs({ audioStarted: true, hasSegments: true, pendingAudio: true, lastDecodeMs: 2345 }));
    expect(text).toBe('transcribing… (last decode 2.3s)');
  });

  it('appends the last-decode duration the same way even when pendingAudio happens to read false', () => {
    const text = mic_status_text(inputs({ audioStarted: true, hasSegments: true, pendingAudio: false, lastDecodeMs: 450 }));
    expect(text).toBe('transcribing… (last decode 0.5s)');
  });
});

describe('mic_status_text: stalled takes priority over everything else', () => {
  it('reports the stall even before any audio was ever captured', () => {
    const text = mic_status_text(inputs({ stalled: true }));
    expect(text).toContain('stalled');
  });

  it('reports the stall even with segments already present and audio pending', () => {
    const text = mic_status_text(inputs({ stalled: true, audioStarted: true, hasSegments: true, pendingAudio: true, lastDecodeMs: 100 }));
    expect(text).toContain('stalled');
  });
});
