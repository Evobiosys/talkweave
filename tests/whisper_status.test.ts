// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  engine_indicator_label,
  engine_label,
  fetch_whisper_status,
  fetch_whisper_available,
  live_status_text,
  mic_option_label,
  mic_ready,
  type WhisperStatus
} from '../app/src/lib/whisper_status';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json_response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('fetch_whisper_status', () => {
  it('returns the full status on a well-formed 200 response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        json_response({
          ok: true,
          available: true,
          bin: 'whisper-cli',
          model: '/m/ggml-base.bin',
          modelPresent: true,
          engine: 'qwen'
        })
    ) as typeof fetch;

    const status = await fetch_whisper_status();
    expect(status).toEqual({
      available: true,
      bin: 'whisper-cli',
      model: '/m/ggml-base.bin',
      modelPresent: true,
      engine: 'qwen',
      detail: null
    });
  });

  it('parses an optional `detail` string alongside `engine`', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        json_response({
          ok: true,
          available: false,
          bin: 'whisper-cli',
          model: '',
          modelPresent: false,
          engine: 'whisper',
          detail: 'binary not on PATH'
        })
    ) as typeof fetch;

    const status = await fetch_whisper_status();
    expect(status.engine).toBe('whisper');
    expect(status.detail).toBe('binary not on PATH');
  });

  it('tolerates a response with no `engine`/`detail` field at all (older server build), degrades to null, not a throw', async () => {
    globalThis.fetch = vi.fn(
      async () => json_response({ ok: true, available: true, bin: 'whisper-cli', model: '/m.bin', modelPresent: true })
    ) as typeof fetch;

    const status = await fetch_whisper_status();
    expect(status.engine).toBeNull();
    expect(status.detail).toBeNull();
  });

  it('tolerates a wrong-typed `engine` field (e.g. a number), degrades to null rather than propagating garbage', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        json_response({ ok: true, available: true, bin: 'whisper-cli', model: '/m.bin', modelPresent: true, engine: 42 })
    ) as typeof fetch;

    const status = await fetch_whisper_status();
    expect(status.engine).toBeNull();
  });

  it('degrades to the conservative "not available" shape on a non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => json_response({}, false)) as typeof fetch;
    const status = await fetch_whisper_status();
    expect(status.available).toBe(false);
    expect(status.modelPresent).toBe(false);
    expect(status.engine).toBeNull();
  });

  it('degrades on a network failure without throwing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const status = await fetch_whisper_status();
    expect(status.available).toBe(false);
  });

  it('degrades on a malformed/non-ok:true JSON body', async () => {
    globalThis.fetch = vi.fn(async () => json_response({ some: 'garbage' })) as typeof fetch;
    const status = await fetch_whisper_status();
    expect(status).toEqual({ available: false, bin: 'whisper-cli', model: '', modelPresent: false, engine: null, detail: null });
  });
});

describe('mic_ready', () => {
  const base = { bin: 'x', model: 'y', engine: null, detail: null };
  it('true only when BOTH available and modelPresent are true', () => {
    expect(mic_ready({ ...base, available: true, modelPresent: true })).toBe(true);
    expect(mic_ready({ ...base, available: true, modelPresent: false })).toBe(false);
    expect(mic_ready({ ...base, available: false, modelPresent: true })).toBe(false);
    expect(mic_ready({ ...base, available: false, modelPresent: false })).toBe(false);
  });
});

describe('engine_label', () => {
  it('maps known ids to a friendly name', () => {
    expect(engine_label('qwen')).toBe('qwen3-asr');
    expect(engine_label('whisper')).toBe('whisper.cpp');
  });

  it('prints an unrecognized id verbatim rather than hiding it', () => {
    expect(engine_label('some-future-engine')).toBe('some-future-engine');
  });

  it('falls back to a generic label for null', () => {
    expect(engine_label(null)).toBe('the local engine');
  });
});

function status(overrides: Partial<WhisperStatus>): WhisperStatus {
  return { available: false, bin: 'whisper-cli', model: '', modelPresent: false, engine: null, detail: null, ...overrides };
}

describe('live_status_text', () => {
  it('names the engine when fully ready, in the handover\'s own example shape (colon instead of an em dash)', () => {
    const text = live_status_text(status({ available: true, modelPresent: true, engine: 'qwen' }));
    expect(text).toBe('recording. listening: qwen3-asr. flags, notes and audio are captured.');
  });

  it('says reachable-but-not-ready when the engine answers but the model/setup is not ready', () => {
    const text = live_status_text(status({ available: true, modelPresent: false, engine: 'whisper' }));
    expect(text).toContain('whisper.cpp reachable, not ready yet');
  });

  it('says plainly when nothing is reachable, and includes `detail` when given', () => {
    const text = live_status_text(status({ available: false, engine: null, detail: 'proxy not responding' }));
    expect(text).toContain('no transcription engine reachable, proxy not responding');
  });

  it('omits the detail clause when none was given', () => {
    const text = live_status_text(status({ available: false }));
    expect(text).toBe('recording. no transcription engine reachable. flags, notes and audio are captured.');
  });
});

describe('mic_option_label', () => {
  it('ready: names the engine', () => {
    expect(mic_option_label(status({ available: true, modelPresent: true, engine: 'qwen' }))).toBe('mic: qwen3-asr');
  });

  it('reachable but not ready: names the engine, points at the README', () => {
    const label = mic_option_label(status({ available: true, modelPresent: false, engine: 'whisper' }));
    expect(label).toBe('mic (whisper.cpp reachable, not ready, see README)');
  });

  it('nothing reachable: generic, engine-agnostic message', () => {
    expect(mic_option_label(status({ available: false }))).toBe('mic (no ASR engine reachable, see README)');
  });
});

describe('engine_indicator_label', () => {
  it('ready', () => {
    expect(engine_indicator_label(status({ available: true, modelPresent: true, engine: 'qwen' }))).toBe('asr: qwen3-asr');
  });

  it('reachable, not ready', () => {
    expect(engine_indicator_label(status({ available: true, modelPresent: false, engine: 'whisper' }))).toBe(
      'asr: whisper.cpp (not ready)'
    );
  });

  it('unreachable', () => {
    expect(engine_indicator_label(status({ available: false }))).toBe('asr: unreachable');
  });
});

describe('fetch_whisper_available (back-compat)', () => {
  it('mirrors status.available', async () => {
    globalThis.fetch = vi.fn(
      async () => json_response({ ok: true, available: true, bin: 'whisper-cli', model: '/m.bin', modelPresent: false })
    ) as typeof fetch;
    expect(await fetch_whisper_available()).toBe(true);
  });
});
