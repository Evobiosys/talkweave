// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { downsample_to_16k, float32_to_pcm16, pcm16_to_bytes, encode_pcm16_chunk, TARGET_SAMPLE_RATE } from '../app/src/lib/pcm_helpers';

describe('downsample_to_16k', () => {
  it('returns the SAME reference (no copy) when already at 16kHz', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsample_to_16k(input, TARGET_SAMPLE_RATE)).toBe(input);
  });

  it('halves the sample count when downsampling 32kHz -> 16kHz', () => {
    const input = new Float32Array(320); // 20ms at 32kHz
    expect(downsample_to_16k(input, 32000).length).toBe(160); // 20ms at 16kHz
  });

  it('interpolates linearly between neighboring samples for a non-integer ratio (24kHz -> 16kHz, ratio 1.5)', () => {
    const input = new Float32Array([0, 1, 2, 3, 4, 5]);
    const out = downsample_to_16k(input, 24000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5); // srcIndex 0.0 -> input[0]
    expect(out[1]).toBeCloseTo(1.5, 5); // srcIndex 1.5 -> halfway between input[1] and input[2]
    expect(out[2]).toBeCloseTo(3, 5); // srcIndex 3.0 -> input[3]
    expect(out[3]).toBeCloseTo(4.5, 5); // srcIndex 4.5 -> halfway between input[4] and input[5]
  });

  it('handles a degenerate/invalid inputSampleRate by returning input unchanged rather than throwing', () => {
    const input = new Float32Array([0.5]);
    expect(downsample_to_16k(input, 0)).toBe(input);
    expect(downsample_to_16k(input, NaN)).toBe(input);
    expect(downsample_to_16k(input, -1)).toBe(input);
  });
});

describe('float32_to_pcm16', () => {
  it('maps 0 -> 0, 1 -> 32767, -1 -> -32768', () => {
    const out = float32_to_pcm16(new Float32Array([0, 1, -1]));
    expect(Array.from(out)).toEqual([0, 32767, -32768]);
  });

  it('clamps out-of-range input rather than wrapping', () => {
    const out = float32_to_pcm16(new Float32Array([2, -2]));
    expect(Array.from(out)).toEqual([32767, -32768]);
  });

  it('preserves length', () => {
    expect(float32_to_pcm16(new Float32Array(10)).length).toBe(10);
  });
});

describe('pcm16_to_bytes', () => {
  it('writes each sample as two little-endian bytes', () => {
    // 258 = 0x0102 -> LE bytes [0x02, 0x01]
    const bytes = pcm16_to_bytes(new Int16Array([258]));
    expect(Array.from(bytes)).toEqual([0x02, 0x01]);
  });

  it('round-trips a negative value correctly (two\'s complement, little-endian)', () => {
    // -1 as int16 = 0xFFFF -> LE bytes [0xFF, 0xFF]
    const bytes = pcm16_to_bytes(new Int16Array([-1]));
    expect(Array.from(bytes)).toEqual([0xff, 0xff]);
  });

  it('produces 2 bytes per sample', () => {
    expect(pcm16_to_bytes(new Int16Array(5)).length).toBe(10);
  });
});

describe('encode_pcm16_chunk (full pipeline)', () => {
  it('downsamples, converts to pcm16, and serializes to bytes in one call', () => {
    const input = new Float32Array([1, -1]); // 2 samples at 32kHz -> 1 sample at 16kHz
    const bytes = encode_pcm16_chunk(input, 32000);
    expect(bytes.length).toBe(2); // 1 sample * 2 bytes
  });

  it('at native 16kHz, output length is exactly 2 bytes per input sample', () => {
    const input = new Float32Array(100);
    const bytes = encode_pcm16_chunk(input, TARGET_SAMPLE_RATE);
    expect(bytes.length).toBe(200);
  });
});
