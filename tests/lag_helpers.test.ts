// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { format_lag_label } from '../app/src/lib/lag_helpers';

describe('format_lag_label', () => {
  it('hides the chip (returns null) for a negative lag', () => {
    expect(format_lag_label(-50)).toBeNull();
  });

  it('hides the chip for a lag under the 300ms threshold', () => {
    expect(format_lag_label(0)).toBeNull();
    expect(format_lag_label(299)).toBeNull();
  });

  it('hides the chip for non-finite input (no lag data yet)', () => {
    expect(format_lag_label(NaN)).toBeNull();
    expect(format_lag_label(Infinity)).toBeNull();
  });

  it('shows a one-decimal seconds label right at and above the threshold', () => {
    expect(format_lag_label(300)).toBe('~0.3s behind');
    expect(format_lag_label(800)).toBe('~0.8s behind');
    expect(format_lag_label(2000)).toBe('~2.0s behind');
  });

  it('stays in seconds up to just under a minute', () => {
    expect(format_lag_label(59000)).toBe('~59.0s behind');
  });

  it('switches to minutes+seconds at and past 60s', () => {
    expect(format_lag_label(60000)).toBe('~1m 0s behind');
    expect(format_lag_label(125000)).toBe('~2m 5s behind');
  });
});
