// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { should_fire_interval_summary } from '../app/src/lib/summary_scheduler';

describe('should_fire_interval_summary', () => {
  it('fires once at least intervalMinutes*60 seconds have elapsed since lastSummaryEndT', () => {
    expect(should_fire_interval_summary(900, 0, 15)).toBe(true); // exactly 15 min
    expect(should_fire_interval_summary(899, 0, 15)).toBe(false); // 1s short
    expect(should_fire_interval_summary(1000, 0, 15)).toBe(true); // past due
  });

  it('measures from lastSummaryEndT, not from 0, once a summary has already fired', () => {
    expect(should_fire_interval_summary(1800, 900, 15)).toBe(true);
    expect(should_fire_interval_summary(1799, 900, 15)).toBe(false);
  });

  it('is always false when intervalMinutes is 0 ("off") or negative', () => {
    expect(should_fire_interval_summary(10000, 0, 0)).toBe(false);
    expect(should_fire_interval_summary(10000, 0, -5)).toBe(false);
  });

  it('is false for non-finite inputs (defensive against a not-yet-settled clock read)', () => {
    expect(should_fire_interval_summary(NaN, 0, 15)).toBe(false);
    expect(should_fire_interval_summary(1000, NaN, 15)).toBe(false);
    expect(should_fire_interval_summary(1000, 0, NaN)).toBe(false);
    expect(should_fire_interval_summary(Infinity, 0, 15)).toBe(false);
  });
});
