// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { resolve_asr_engine_mode, select_asr_engine } from '../server/lib/asr_engine.mjs';

const QWEN_UP = { available: true, bin: 'http://127.0.0.1:8001', model: 'qwen3-asr', modelPresent: true };
const QWEN_DOWN = { available: false, bin: 'http://127.0.0.1:8001', model: 'qwen3-asr', modelPresent: false };
const QWEN_NO_MODEL = { available: true, bin: 'http://127.0.0.1:8001', model: 'qwen3-asr', modelPresent: false };
const WHISPER_UP = { available: true, bin: 'whisper-cli', model: '/models/ggml-base.bin', modelPresent: true };
const WHISPER_DOWN = { available: false, bin: 'whisper-cli', model: '/models/ggml-base.bin', modelPresent: false };

/** Counts calls and returns whatever `sequence` yields next (repeating the
 *  last entry once exhausted) — lets a single stub answer differently
 *  across a check() then a later checkAvailability() re-probe. */
function make_stub(...sequence) {
  let i = 0;
  const fn = (...args) => {
    const value = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    fn.calls = i;
    return typeof value === 'function' ? value(...args) : value;
  };
  fn.calls = 0;
  return fn;
}

describe('resolve_asr_engine_mode', () => {
  it('defaults to auto with no env override', () => {
    expect(resolve_asr_engine_mode({})).toBe('auto');
  });
  it('honors qwen', () => {
    expect(resolve_asr_engine_mode({ TALKWEAVE_ASR_ENGINE: 'qwen' })).toBe('qwen');
  });
  it('honors whisper', () => {
    expect(resolve_asr_engine_mode({ TALKWEAVE_ASR_ENGINE: 'whisper' })).toBe('whisper');
  });
  it('is case-insensitive and trims whitespace', () => {
    expect(resolve_asr_engine_mode({ TALKWEAVE_ASR_ENGINE: '  QWEN  ' })).toBe('qwen');
  });
  it('falls back to auto for an unrecognized value', () => {
    expect(resolve_asr_engine_mode({ TALKWEAVE_ASR_ENGINE: 'typo' })).toBe('auto');
  });
});

describe('select_asr_engine: mode=qwen (forced, no fallback)', () => {
  it('selects qwen when the proxy is usable', async () => {
    const checkQwen = make_stub(QWEN_UP);
    const checkWhisper = make_stub(WHISPER_UP); // must never be consulted
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'qwen' },
      checkQwen: async () => checkQwen(),
      checkWhisper
    });
    expect(selection.mode).toBe('qwen');
    expect(selection.engine).toBe('qwen');
    expect(selection.bin).toBe('http://127.0.0.1:8001');
    expect(selection.model).toBe('qwen3-asr');
    expect(checkWhisper.calls).toBe(0);
  });

  it('reports engine:none, with no fallback to whisper, when the proxy is unusable', async () => {
    const checkWhisper = make_stub(WHISPER_UP); // usable, but forced qwen must not use it
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'qwen' },
      checkQwen: async () => QWEN_DOWN,
      checkWhisper
    });
    expect(selection.engine).toBe('none');
    expect(selection.bin).toBe('http://127.0.0.1:8001');
    expect(checkWhisper.calls).toBe(0);
  });

  it('checkAvailability stays pinned to unavailable when forced qwen is unusable, even if a later probe would see it recover', async () => {
    const checkQwen = make_stub(QWEN_DOWN, QWEN_UP);
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'qwen' },
      checkQwen: async () => checkQwen()
    });
    expect(selection.engine).toBe('none');
    const live = await selection.checkAvailability();
    expect(live).toEqual({ available: false, bin: QWEN_UP.bin, model: QWEN_UP.model, modelPresent: false, engine: 'none' });
  });

  it('checkAvailability re-probes qwen and keeps reporting engine:qwen on a later call', async () => {
    const checkQwen = make_stub(QWEN_UP, QWEN_DOWN);
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'qwen' },
      checkQwen: async () => checkQwen()
    });
    expect(selection.engine).toBe('qwen');
    const live = await selection.checkAvailability();
    expect(live).toEqual({ ...QWEN_DOWN, engine: 'qwen' });
  });
});

describe('select_asr_engine: mode=whisper (forced, no fallback)', () => {
  it('selects whisper when it is usable', async () => {
    const checkQwen = make_stub(QWEN_UP); // must never be consulted
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'whisper' },
      checkQwen: async () => checkQwen(),
      checkWhisper: () => WHISPER_UP
    });
    expect(selection.engine).toBe('whisper');
    expect(selection.bin).toBe('whisper-cli');
    expect(checkQwen.calls).toBe(0);
  });

  it('reports engine:none, with no fallback to qwen, when whisper is unusable', async () => {
    const checkQwen = make_stub(QWEN_UP);
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'whisper' },
      checkQwen: async () => checkQwen(),
      checkWhisper: () => WHISPER_DOWN
    });
    expect(selection.engine).toBe('none');
    expect(checkQwen.calls).toBe(0);
  });
});

describe('select_asr_engine: mode=auto (default, fallback order)', () => {
  it('prefers qwen when both are usable', async () => {
    const checkWhisper = make_stub(WHISPER_UP);
    const selection = await select_asr_engine({
      env: {},
      checkQwen: async () => QWEN_UP,
      checkWhisper
    });
    expect(selection.mode).toBe('auto');
    expect(selection.engine).toBe('qwen');
    expect(checkWhisper.calls).toBe(0); // whisper never even checked once qwen works
  });

  it('falls back to whisper when qwen is unreachable', async () => {
    const selection = await select_asr_engine({
      env: {},
      checkQwen: async () => QWEN_DOWN,
      checkWhisper: () => WHISPER_UP
    });
    expect(selection.engine).toBe('whisper');
    expect(selection.bin).toBe('whisper-cli');
  });

  it('falls back to whisper when qwen answers but lacks the model', async () => {
    const selection = await select_asr_engine({
      env: {},
      checkQwen: async () => QWEN_NO_MODEL,
      checkWhisper: () => WHISPER_UP
    });
    expect(selection.engine).toBe('whisper');
  });

  it('reports engine:none when neither backend is usable', async () => {
    const selection = await select_asr_engine({
      env: {},
      checkQwen: async () => QWEN_DOWN,
      checkWhisper: () => WHISPER_DOWN
    });
    expect(selection.engine).toBe('none');
    expect(selection.bin).toBe('whisper-cli'); // last-attempted backend's diagnostic info
  });

  it('checkAvailability on the none-selected auto path stays pinned to unavailable even if the last-attempted backend recovers', async () => {
    // This process never wired up a working whisperRun for whisper.cpp
    // once it was found unusable at startup (nothing selected it) — so
    // even though the live re-probe below sees whisper.cpp come back
    // (WHISPER_UP), `available`/`modelPresent` must stay false. Reporting
    // true here would tell /api/mic/start's gate (and the client reading
    // this same payload) that a session can start, when nothing in this
    // process can actually serve it. Only `bin`/`model` — diagnostic,
    // not a promise of service — are allowed to reflect the live probe.
    const checkWhisper = make_stub(WHISPER_DOWN, WHISPER_UP);
    const selection = await select_asr_engine({
      env: {},
      checkQwen: async () => QWEN_DOWN,
      checkWhisper
    });
    expect(selection.engine).toBe('none');
    const live = await selection.checkAvailability();
    expect(live).toEqual({ available: false, bin: WHISPER_UP.bin, model: WHISPER_UP.model, modelPresent: false, engine: 'none' });
  });

  it('checkAvailability on the qwen-selected auto path re-probes qwen live', async () => {
    const checkQwen = make_stub(QWEN_UP, QWEN_DOWN);
    const selection = await select_asr_engine({
      env: {},
      checkQwen: async () => checkQwen(),
      checkWhisper: () => WHISPER_UP
    });
    expect(selection.engine).toBe('qwen');
    const live = await selection.checkAvailability();
    expect(live).toEqual({ ...QWEN_DOWN, engine: 'qwen' });
  });
});

describe('select_asr_engine: whisperRun wiring', () => {
  it('wraps the qwen run through makeQwenRun when qwen is selected', async () => {
    let capturedStatus;
    const qwenRun = async () => 'qwen output';
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'qwen' },
      checkQwen: async () => QWEN_UP,
      makeQwenRun: (status) => {
        capturedStatus = status;
        return qwenRun;
      }
    });
    expect(selection.whisperRun).toBe(qwenRun);
    expect(capturedStatus).toEqual(QWEN_UP);
  });

  it('uses the injected whisperRun as-is when whisper is selected', async () => {
    const whisperRun = async () => 'whisper output';
    const selection = await select_asr_engine({
      env: { TALKWEAVE_ASR_ENGINE: 'whisper' },
      checkWhisper: () => WHISPER_UP,
      whisperRun
    });
    expect(selection.whisperRun).toBe(whisperRun);
  });
});
