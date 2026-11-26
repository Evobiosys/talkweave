// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { pcm16_to_wav, WAV_SAMPLE_RATE, WAV_CHANNELS, WAV_BITS_PER_SAMPLE } from '../server/lib/wav.mjs';

describe('pcm16_to_wav', () => {
  it('writes a canonical 44-byte RIFF/WAVE header, then the raw PCM bytes verbatim', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); // 4 samples of 16-bit
    const wav = pcm16_to_wav(pcm);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('encodes the default 16kHz/mono/16-bit format fields correctly', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcm16_to_wav(pcm);

    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format
    expect(wav.readUInt16LE(22)).toBe(WAV_CHANNELS);
    expect(wav.readUInt32LE(24)).toBe(WAV_SAMPLE_RATE);
    expect(wav.readUInt16LE(34)).toBe(WAV_BITS_PER_SAMPLE);
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size
    const blockAlign = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8;
    expect(wav.readUInt16LE(32)).toBe(blockAlign);
    expect(wav.readUInt32LE(28)).toBe(WAV_SAMPLE_RATE * blockAlign); // byte rate
  });

  it('honors explicit sampleRate/channels/bitsPerSample overrides', () => {
    const pcm = Buffer.alloc(40);
    const wav = pcm16_to_wav(pcm, { sampleRate: 8000, channels: 2, bitsPerSample: 8 });

    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(8);
  });

  it('handles an empty PCM buffer without throwing (zero-length data chunk)', () => {
    const wav = pcm16_to_wav(Buffer.alloc(0));
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});
