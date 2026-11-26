// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — v0.2 live transcription. Pure audio-math helpers for
// mic_engine.ts's raw-PCM capture path (see that module's header comment
// for why a SEPARATE PCM path exists alongside audio_recorder.ts's webm
// recording: whisper-cli reads a WAV file, not webm/opus, and this
// project has no ffmpeg/decoder dependency to bridge the two — see
// server/lib/wav.mjs's header comment).
//
// Split out from mic_engine.ts for the same reason audio_helpers.ts is
// split out from audio_recorder.ts: an `AudioContext`/`ScriptProcessorNode`
// only exists in a real browser (this repo's vitest config has no jsdom,
// and even jsdom doesn't implement the Web Audio API), so anything that
// touches them can't be unit-tested — but the actual MATH (resampling,
// float-to-int16 conversion, endianness) has zero DOM dependency and is
// fully testable as plain functions. mic_engine.ts is thin glue calling
// these; verified end-to-end only via headless Playwright (task-7's
// precedent).
//
// Resampling: linear interpolation, not a proper band-limited resampler
// (no windowed-sinc, no anti-aliasing filter) — adequate for speech
// destined for a speech-recognition model, not a hi-fi requirement, and
// keeps this dependency-free (no npm DSP library, per this project's
// "runtime dependencies: NONE beyond Node stdlib" / no-CDN constraint,
// which applies to app/ code exactly as much as server/ code).
//
// Target format is fixed at 16kHz mono — the one format server/lib/wav.mjs
// and whisper.cpp models actually expect — so these functions don't take
// a configurable output rate; only the INPUT rate varies (whatever the
// browser's `AudioContext` actually runs at, typically 44100 or 48000,
// never forced to 16000 at construction since Safari/some devices reject
// unsupported `sampleRate` values passed to `new AudioContext()`).

export const TARGET_SAMPLE_RATE = 16000;

/**
 * Downsamples `input` (assumed mono, `[-1, 1]` float samples) from
 * `inputSampleRate` to `TARGET_SAMPLE_RATE` via linear interpolation.
 * Returns `input` UNCHANGED (same reference) when already at the target
 * rate — the common case never needs a fresh allocation.
 */
export function downsample_to_16k(input: Float32Array, inputSampleRate: number): Float32Array {
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) return input;
  if (inputSampleRate === TARGET_SAMPLE_RATE) return input;

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(0, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, input.length - 1);
    const frac = srcIndex - srcFloor;
    output[i] = input[srcFloor] * (1 - frac) + input[srcCeil] * frac;
  }
  return output;
}

/**
 * Converts `[-1, 1]` float samples to signed 16-bit PCM, clamping any
 * out-of-range input (a clipped/over-driven mic signal) rather than
 * wrapping — `Int16Array`'s own assignment already clamps on overflow in
 * every JS engine this runs in, but the explicit `Math.max(-1, Math.min(1,
 * ...))` documents that as intentional rather than incidental.
 */
export function float32_to_pcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Serializes `samples` as little-endian bytes — explicit `DataView`
 * writes rather than relying on `Int16Array.buffer`'s platform
 * endianness: every real target here (V8/JavaScriptCore in a browser) IS
 * little-endian, but writing it out explicitly means this function's
 * correctness doesn't depend on that fact staying true, and it matches
 * `server/lib/wav.mjs`'s own explicit `writeUInt16LE`/`writeUInt32LE`
 * calls on the receiving end.
 */
export function pcm16_to_bytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  return bytes;
}

/**
 * The full chunk-encoding pipeline `mic_engine.ts`'s `onaudioprocess`
 * callback calls once per captured buffer: downsample to 16kHz, convert
 * to PCM16, serialize as little-endian bytes ready to POST as
 * `application/octet-stream` to `/api/mic/audio/:id`.
 */
export function encode_pcm16_chunk(input: Float32Array, inputSampleRate: number): Uint8Array {
  return pcm16_to_bytes(float32_to_pcm16(downsample_to_16k(input, inputSampleRate)));
}
