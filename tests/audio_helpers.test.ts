// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import type { Segment } from '../shared/model';
import {
  data_extent_seconds,
  elapsed_excluding_paused,
  elapsed_seconds,
  marker_percent,
  pick_mime_type,
  resolve_current_t,
  resolve_duration,
  resolve_review_t,
  segment_at
} from '../app/src/lib/audio_helpers';

function seg(id: string, tStart: number, tEnd: number): Segment {
  return { id, speaker: 'L', tStart, tEnd, text: id, final: true };
}

describe('audio_helpers: segment_at', () => {
  const segments = [seg('s1', 0, 2), seg('s2', 2, 5), seg('s3', 8, 10)];

  it('returns the segment covering t (inclusive of both endpoints)', () => {
    expect(segment_at(segments, 0)?.id).toBe('s1');
    expect(segment_at(segments, 1)?.id).toBe('s1');
    expect(segment_at(segments, 2)?.id).toBe('s1'); // boundary: earlier segment's tEnd wins (first covering match)
    expect(segment_at(segments, 3)?.id).toBe('s2');
    expect(segment_at(segments, 5)?.id).toBe('s2');
    expect(segment_at(segments, 10)?.id).toBe('s3');
  });

  it('in a silence gap between segments, resolves to the earlier segment (last one with tStart <= t)', () => {
    expect(segment_at(segments, 6)?.id).toBe('s2');
    expect(segment_at(segments, 7.9)?.id).toBe('s2');
  });

  it('returns null for t before every segment', () => {
    expect(segment_at(segments, -1)).toBeNull();
  });

  it('returns null for an empty segment list', () => {
    expect(segment_at([], 5)).toBeNull();
  });

  it('returns null for a non-finite t', () => {
    expect(segment_at(segments, NaN)).toBeNull();
    expect(segment_at(segments, Infinity)).toBeNull();
  });

  it('resolves to the last segment for t past the final segment', () => {
    expect(segment_at(segments, 999)?.id).toBe('s3');
  });
});

describe('audio_helpers: marker_percent', () => {
  it('computes t as a percentage of duration', () => {
    expect(marker_percent(0, 10)).toBe(0);
    expect(marker_percent(5, 10)).toBe(50);
    expect(marker_percent(10, 10)).toBe(100);
  });

  it('clamps above 100% (t past duration) and below 0%', () => {
    expect(marker_percent(15, 10)).toBe(100);
    expect(marker_percent(-5, 10)).toBe(0);
  });

  it('returns 0 for non-positive or non-finite duration rather than NaN/Infinity', () => {
    expect(marker_percent(5, 0)).toBe(0);
    expect(marker_percent(5, -1)).toBe(0);
    expect(marker_percent(5, NaN)).toBe(0);
    expect(marker_percent(5, Infinity)).toBe(0);
  });

  it('returns 0 for a non-finite t', () => {
    expect(marker_percent(NaN, 10)).toBe(0);
    expect(marker_percent(Infinity, 10)).toBe(0);
  });
});

describe('audio_helpers: resolve_duration', () => {
  it('prefers a finite, positive rawDuration', () => {
    expect(resolve_duration(42, 10)).toBe(42);
  });

  it('falls back when rawDuration is Infinity (recorded webm, indefinite container duration)', () => {
    expect(resolve_duration(Infinity, 10)).toBe(10);
  });

  it('falls back when rawDuration is 0, negative, or NaN', () => {
    expect(resolve_duration(0, 10)).toBe(10);
    expect(resolve_duration(-1, 10)).toBe(10);
    expect(resolve_duration(NaN, 10)).toBe(10);
  });

  it('returns 0 when both rawDuration and fallback are unusable', () => {
    expect(resolve_duration(Infinity, 0)).toBe(0);
    expect(resolve_duration(NaN, NaN)).toBe(0);
  });
});

describe('audio_helpers: data_extent_seconds', () => {
  it('returns the max t across segments/flags/notes/factChecks', () => {
    const session = {
      segments: [seg('s1', 0, 3), seg('s2', 3, 7)],
      flags: [{ id: 'f1', t: 4, by: 'L' as const, segmentId: null, claimText: null, charStart: null, charEnd: null, source: 'key' as const }],
      notes: [{ id: 'n1', t: 20, by: 'R' as const, text: 'x' }],
      factChecks: [
        {
          id: 'fc1',
          t: 12,
          by: 'L' as const,
          question: 'q',
          quick: null,
          deep: null
        }
      ]
    };
    expect(data_extent_seconds(session)).toBe(20);
  });

  it('returns 0 for a session with no timestamped data', () => {
    expect(data_extent_seconds({ segments: [], flags: [], notes: [], factChecks: [] })).toBe(0);
  });
});

describe('audio_helpers: elapsed_seconds', () => {
  it('computes seconds between two performance.now()-style ms readings', () => {
    expect(elapsed_seconds(1000, 1000)).toBe(0);
    expect(elapsed_seconds(1000, 6500)).toBeCloseTo(5.5, 5);
  });

  it('clamps a negative delta to 0 rather than going negative', () => {
    expect(elapsed_seconds(5000, 1000)).toBe(0);
  });
});

describe('audio_helpers: elapsed_excluding_paused (v0.3 train-fixes Part B)', () => {
  it('with no pauses, behaves exactly like elapsed_seconds', () => {
    expect(elapsed_excluding_paused(1000, 6500, 0)).toBeCloseTo(5.5, 5);
  });

  it('subtracts totalPausedMs from the raw elapsed time', () => {
    // 10s of raw elapsed, 4s of that was paused -> 6s of real elapsed.
    expect(elapsed_excluding_paused(0, 10000, 4000)).toBeCloseTo(6, 5);
  });

  it('freezes at the pre-pause value when effectiveNowMs is the pause instant itself', () => {
    // Simulates now() called while paused: effectiveNowMs is pinned to
    // pausedAtMs (the instant pause() was called), not a fresh
    // performance.now() reading — the clock genuinely stops advancing.
    const startMs = 0;
    const pausedAtMs = 8000; // paused after 8s of real recording
    const totalPausedMsBeforeThisPause = 0;
    const atPauseTime = elapsed_excluding_paused(startMs, pausedAtMs, totalPausedMsBeforeThisPause);
    // "now()" called again 3s later, still paused: effectiveNowMs is
    // STILL pausedAtMs (caller never advances it while paused).
    const laterWhileStillPaused = elapsed_excluding_paused(startMs, pausedAtMs, totalPausedMsBeforeThisPause);
    expect(laterWhileStillPaused).toBe(atPauseTime);
    expect(atPauseTime).toBeCloseTo(8, 5);
  });

  it('resuming after a pause continues from exactly where it left off, excluding the paused interval', () => {
    const startMs = 0;
    // Paused at raw-elapsed 8s, resumed after a real 5s pause (13000ms raw).
    const pausedAtMs = 8000;
    const resumedAtMs = 13000;
    const totalPausedMs = resumedAtMs - pausedAtMs; // 5000ms
    // 1s of real recording after resume -> raw elapsed 14000ms.
    const oneSecondAfterResume = 14000;
    expect(elapsed_excluding_paused(startMs, oneSecondAfterResume, totalPausedMs)).toBeCloseTo(9, 5);
  });

  it('clamps to 0 rather than going negative when totalPausedMs exceeds raw elapsed', () => {
    expect(elapsed_excluding_paused(0, 1000, 5000)).toBe(0);
  });
});

describe('audio_helpers: pick_mime_type', () => {
  it('prefers audio/webm;codecs=opus when supported', () => {
    const isSupported = (t: string) => t === 'audio/webm;codecs=opus' || t === 'audio/webm';
    expect(pick_mime_type(isSupported)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to plain audio/webm when opus codec is not supported', () => {
    const isSupported = (t: string) => t === 'audio/webm';
    expect(pick_mime_type(isSupported)).toBe('audio/webm');
  });

  it('returns empty string (browser default) when neither is supported', () => {
    expect(pick_mime_type(() => false)).toBe('');
  });
});

describe('audio_helpers: resolve_current_t', () => {
  it('uses the recorder clock once the timebase is ready', () => {
    expect(resolve_current_t(true, 12.3, 99)).toBe(12.3);
  });

  it('falls back to the wall-clock source before the recorder timebase is established (fix round 1, Finding 1)', () => {
    // recorder exists (a live session), but start()'s async getUserMedia/
    // MediaRecorder negotiation hasn't settled yet — `recorderReady` is
    // false, so a flag/note created right now must NOT be stamped with
    // the recorder's own (meaningless-until-ready) `now()` value.
    expect(resolve_current_t(false, 0, 5.5)).toBe(5.5);
  });

  it('falls back even when the not-yet-ready recorder now() is non-zero garbage', () => {
    expect(resolve_current_t(false, 42, 5.5)).toBe(5.5);
  });
});

describe('audio_helpers: resolve_review_t', () => {
  it('prefers the actual playback position when one exists', () => {
    // review mode + playbackT -> playbackT, regardless of how far the
    // session's own data extends.
    expect(resolve_review_t(42.5, 259200)).toBe(42.5);
  });

  it('prefers playbackT even when it is 0 (played back to the very start)', () => {
    expect(resolve_review_t(0, 500)).toBe(0);
  });

  it('clamps to the session data extent when nothing has played yet', () => {
    // review mode without playback -> clamped extent, NOT wall-clock time
    // since the session was created (final review fix, Important 1).
    expect(resolve_review_t(null, 340)).toBe(340);
  });

  it('returns 0 for an empty session with no playback and no data extent', () => {
    expect(resolve_review_t(null, 0)).toBe(0);
  });

  it('ignores a non-finite data extent (defensive)', () => {
    expect(resolve_review_t(null, Number.NaN)).toBe(0);
  });
});
