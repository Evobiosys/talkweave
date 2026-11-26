// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — v0.2 live transcription. Minimal PCM16LE -> WAV encoder.
//
// whisper-cli (whisper.cpp's batch CLI) reads a WAV file, not a raw PCM
// stream — see whisper_stream.mjs's header comment for why this project's
// mic-transcription adapter re-invokes whisper-cli on a growing/sliding
// buffer of already-downsampled 16kHz mono PCM16 audio (from app/src/lib/
// pcm_helpers.ts) rather than trying to feed it a persistent stdin stream.
// This module only ever needs to wrap ALREADY 16kHz-mono-PCM16 bytes (the
// client-side resampling is done before the bytes ever leave the browser,
// see pcm_helpers.ts), so it hardcodes those three parameters rather than
// building a general-purpose WAV writer — no other caller in this repo
// needs anything else. No npm dependency: canonical 44-byte PCM WAV
// header, written by hand with `Buffer`, per this project's "runtime
// dependencies: NONE beyond Node stdlib" constraint.

export const WAV_SAMPLE_RATE = 16000;
export const WAV_CHANNELS = 1;
export const WAV_BITS_PER_SAMPLE = 16;

/**
 * Wraps raw PCM16LE mono audio bytes in a standard 44-byte canonical WAV
 * header. `pcmBytes` is assumed already 16kHz/mono/16-bit — this function
 * does no resampling or validation of the audio content itself, only
 * writes byte counts derived from `pcmBytes.length` into the header.
 * @param {Buffer} pcmBytes
 * @param {{ sampleRate?: number; channels?: number; bitsPerSample?: number }} [options]
 * @returns {Buffer}
 */
export function pcm16_to_wav(pcmBytes, options = {}) {
  const sampleRate = options.sampleRate ?? WAV_SAMPLE_RATE;
  const channels = options.channels ?? WAV_CHANNELS;
  const bitsPerSample = options.bitsPerSample ?? WAV_BITS_PER_SAMPLE;

  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format: 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBytes]);
}
