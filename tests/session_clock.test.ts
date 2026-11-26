// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { format_hms, session_elapsed_seconds } from '../app/src/lib/session_clock';

describe('session_clock: session_elapsed_seconds', () => {
  it('computes seconds elapsed since startedAt', () => {
    const startedAt = '2026-08-18T10:00:00.000Z';
    const nowMs = Date.parse('2026-08-18T10:00:05.500Z');
    expect(session_elapsed_seconds(startedAt, nowMs)).toBeCloseTo(5.5, 5);
  });

  it('returns 0 at exactly startedAt', () => {
    const startedAt = '2026-08-18T10:00:00.000Z';
    expect(session_elapsed_seconds(startedAt, Date.parse(startedAt))).toBe(0);
  });

  it('returns 0 (not negative) when nowMs is before startedAt', () => {
    const startedAt = '2026-08-18T10:00:05.000Z';
    const nowMs = Date.parse('2026-08-18T10:00:00.000Z');
    expect(session_elapsed_seconds(startedAt, nowMs)).toBe(0);
  });

  it('returns 0 for an unparseable startedAt rather than NaN', () => {
    expect(session_elapsed_seconds('not-a-date', Date.now())).toBe(0);
  });

  it('returns 0 for an empty startedAt', () => {
    expect(session_elapsed_seconds('', Date.now())).toBe(0);
  });
});

describe('session_clock: format_hms', () => {
  it('zero-pads all three fields', () => {
    expect(format_hms(0)).toBe('00:00:00');
    expect(format_hms(5)).toBe('00:00:05');
    expect(format_hms(65)).toBe('00:01:05');
    expect(format_hms(3661)).toBe('01:01:01');
  });

  it('floors rather than rounds (never prints an impossible "60")', () => {
    expect(format_hms(59.9)).toBe('00:00:59');
    expect(format_hms(3599.999)).toBe('00:59:59');
  });

  it('grows the hours field past 99 rather than wrapping', () => {
    expect(format_hms(100 * 3600)).toBe('100:00:00');
  });

  it('clamps negative/NaN input to 00:00:00', () => {
    expect(format_hms(-5)).toBe('00:00:00');
    expect(format_hms(NaN)).toBe('00:00:00');
  });
});
