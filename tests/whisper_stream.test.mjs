// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolve_whisper_bin,
  check_bin_available,
  default_model_path,
  find_repo_model,
  resolve_whisper_model,
  check_whisper_availability,
  create_mic_stream_registry,
  default_whisper_run,
  resolve_tick_ms,
  resolve_first_window_ms,
  DEFAULT_TICK_MS,
  DEFAULT_FIRST_WINDOW_MS
} from '../server/lib/whisper_stream.mjs';

/** Polls `predicate` (real timers, real short delays — the registry runs
 *  real `setInterval` ticks) until it returns true or `timeoutMs` elapses. */
async function wait_until(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('wait_until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('resolve_whisper_bin', () => {
  it('defaults to whisper-cli with no env override', () => {
    expect(resolve_whisper_bin({})).toBe('whisper-cli');
  });
  it('honors TALKWEAVE_WHISPER_BIN, trimmed', () => {
    expect(resolve_whisper_bin({ TALKWEAVE_WHISPER_BIN: '  /opt/bin/whisper-cli  ' })).toBe('/opt/bin/whisper-cli');
  });
  it('ignores an empty/whitespace-only override', () => {
    expect(resolve_whisper_bin({ TALKWEAVE_WHISPER_BIN: '   ' })).toBe('whisper-cli');
  });
});

describe('resolve_tick_ms', () => {
  it('defaults to DEFAULT_TICK_MS with no env override', () => {
    expect(resolve_tick_ms({})).toBe(DEFAULT_TICK_MS);
  });
  it('honors a valid TALKWEAVE_WHISPER_TICK_MS override', () => {
    expect(resolve_tick_ms({ TALKWEAVE_WHISPER_TICK_MS: '3000' })).toBe(3000);
  });
  it('ignores a non-numeric, zero, or negative override', () => {
    expect(resolve_tick_ms({ TALKWEAVE_WHISPER_TICK_MS: 'nope' })).toBe(DEFAULT_TICK_MS);
    expect(resolve_tick_ms({ TALKWEAVE_WHISPER_TICK_MS: '0' })).toBe(DEFAULT_TICK_MS);
    expect(resolve_tick_ms({ TALKWEAVE_WHISPER_TICK_MS: '-5' })).toBe(DEFAULT_TICK_MS);
  });
});

describe('resolve_first_window_ms', () => {
  it('defaults to DEFAULT_FIRST_WINDOW_MS with no env override', () => {
    expect(resolve_first_window_ms({})).toBe(DEFAULT_FIRST_WINDOW_MS);
  });
  it('honors a valid TALKWEAVE_WHISPER_FIRST_WINDOW_MS override', () => {
    expect(resolve_first_window_ms({ TALKWEAVE_WHISPER_FIRST_WINDOW_MS: '400' })).toBe(400);
  });
  it('ignores a non-numeric, zero, or negative override', () => {
    expect(resolve_first_window_ms({ TALKWEAVE_WHISPER_FIRST_WINDOW_MS: 'nope' })).toBe(DEFAULT_FIRST_WINDOW_MS);
    expect(resolve_first_window_ms({ TALKWEAVE_WHISPER_FIRST_WINDOW_MS: '0' })).toBe(DEFAULT_FIRST_WINDOW_MS);
    expect(resolve_first_window_ms({ TALKWEAVE_WHISPER_FIRST_WINDOW_MS: '-5' })).toBe(DEFAULT_FIRST_WINDOW_MS);
  });
});

describe('check_bin_available', () => {
  it('true for a binary that really is on PATH', () => {
    expect(check_bin_available('ls')).toBe(true);
  });
  it('false for a name that is not on PATH', () => {
    expect(check_bin_available('talkweave-definitely-not-a-real-binary-xyz')).toBe(false);
  });
});

describe('default_model_path', () => {
  it('defaults under ~/Library/Application Support/TalkWeave/models', () => {
    expect(default_model_path({})).toMatch(/Library\/Application Support\/TalkWeave\/models\/ggml-base\.bin$/);
  });
  it('honors TALKWEAVE_WHISPER_MODEL, trimmed', () => {
    expect(default_model_path({ TALKWEAVE_WHISPER_MODEL: '  /models/mine.bin  ' })).toBe('/models/mine.bin');
  });
});

describe('find_repo_model', () => {
  let workDir;
  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  it('returns null when there is no models/ dir at all', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'talkweave-wstest-'));
    expect(find_repo_model(workDir)).toBeNull();
  });

  it('returns null when models/ has no ggml-*.bin file', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'talkweave-wstest-'));
    await mkdir(join(workDir, 'models'));
    await writeFile(join(workDir, 'models', 'readme.txt'), 'nope');
    expect(find_repo_model(workDir)).toBeNull();
  });

  it('finds a ggml-*.bin file, sorted deterministically when more than one exists', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'talkweave-wstest-'));
    await mkdir(join(workDir, 'models'));
    await writeFile(join(workDir, 'models', 'ggml-small.bin'), 'x');
    await writeFile(join(workDir, 'models', 'ggml-base.bin'), 'x');
    expect(find_repo_model(workDir)).toBe(join(workDir, 'models', 'ggml-base.bin'));
  });
});

describe('resolve_whisper_model', () => {
  let workDir;
  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  it('uses the env/default path when that file exists', () => {
    const result = resolve_whisper_model({ env: { TALKWEAVE_WHISPER_MODEL: '/models/mine.bin' }, fileExists: () => true });
    expect(result).toEqual({ model: '/models/mine.bin', modelPresent: true });
  });

  it('falls back to a repo models/ggml-*.bin match when the primary path is missing', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'talkweave-wstest-'));
    await mkdir(join(workDir, 'models'));
    await writeFile(join(workDir, 'models', 'ggml-base.bin'), 'x');

    const result = resolve_whisper_model({ env: { TALKWEAVE_WHISPER_MODEL: '/does/not/exist.bin' }, repoRoot: workDir });
    expect(result).toEqual({ model: join(workDir, 'models', 'ggml-base.bin'), modelPresent: true });
  });

  it('reports modelPresent:false and the originally-resolved path when neither exists', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'talkweave-wstest-'));
    const result = resolve_whisper_model({ env: { TALKWEAVE_WHISPER_MODEL: '/does/not/exist.bin' }, repoRoot: workDir });
    expect(result).toEqual({ model: '/does/not/exist.bin', modelPresent: false });
  });
});

describe('check_whisper_availability', () => {
  it('combines an injected binCheck and fileExists into the full {available, bin, model, modelPresent} shape', () => {
    const result = check_whisper_availability({
      env: { TALKWEAVE_WHISPER_BIN: 'whisper-cli', TALKWEAVE_WHISPER_MODEL: '/models/x.bin' },
      binCheck: () => true,
      fileExists: () => true
    });
    expect(result).toEqual({ available: true, bin: 'whisper-cli', model: '/models/x.bin', modelPresent: true });
  });

  it('reports available:false with modelPresent still independently reported', () => {
    const result = check_whisper_availability({
      env: { TALKWEAVE_WHISPER_MODEL: '/models/x.bin' },
      binCheck: () => false,
      fileExists: () => true
    });
    expect(result.available).toBe(false);
    expect(result.modelPresent).toBe(true);
  });
});

describe('default_whisper_run (real spawn against a stub "whisper-cli" script)', () => {
  let stubDir;
  let stubPath;

  afterEach(async () => {
    if (stubDir) await rm(stubDir, { recursive: true, force: true });
    stubDir = undefined;
  });

  /** Writes a tiny executable Node script standing in for whisper-cli:
   *  prints `text` to stdout after `delayMs`, ignoring its argv (mirrors
   *  how little this adapter's own parsing cares about whisper-cli's real
   *  flag set — it only reads stdout). */
  async function write_stub(text, delayMs = 0) {
    stubDir = await mkdtemp(join(tmpdir(), 'talkweave-whisper-stub-'));
    stubPath = join(stubDir, 'whisper-cli-stub.mjs');
    await writeFile(
      stubPath,
      `#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write(${JSON.stringify(text)}); }, ${delayMs});\n`
    );
    await chmod(stubPath, 0o755);
    return stubPath;
  }

  it('spawns the executable stub directly and returns its trimmed stdout as the transcribed text', async () => {
    const bin = await write_stub('  hello from the stub  \n');
    const text = await default_whisper_run(Buffer.from([1, 2, 3, 4]), { bin, model: '/models/x.bin', timeoutMs: 2000 });
    expect(text).toBe('hello from the stub');
  });

  it('always removes the temp WAV file it wrote, even on success', async () => {
    const bin = await write_stub('ok');
    const before = (await readdir(tmpdir())).filter((f) => f.startsWith('talkweave-mic-'));
    await default_whisper_run(Buffer.from([9, 9, 9, 9]), { bin, model: '/models/x.bin', timeoutMs: 2000 });
    const after = (await readdir(tmpdir())).filter((f) => f.startsWith('talkweave-mic-'));
    expect(after.length).toBe(before.length);
  });

  it('kills a hung process past timeoutMs and resolves "" rather than hanging forever', async () => {
    const bin = await write_stub('too late', 5000);
    const startedAt = Date.now();
    const text = await default_whisper_run(Buffer.from([1]), { bin, model: '/models/x.bin', timeoutMs: 80 });
    expect(text).toBe('');
    expect(Date.now() - startedAt).toBeLessThan(3000); // well under the stub's own 5s delay
  });

  it('resolves "" (never throws) when the binary does not exist at all', async () => {
    const text = await default_whisper_run(Buffer.from([1]), {
      bin: '/does/not/exist/whisper-cli',
      model: '/models/x.bin',
      timeoutMs: 500
    });
    expect(text).toBe('');
  });
});

describe('create_mic_stream_registry: id lifecycle', () => {
  it('create() returns a fresh id each time; has() reflects it; stop() removes it', () => {
    const registry = create_mic_stream_registry({ sweepMs: 0, whisperRun: async () => '' });
    const a = registry.create();
    const b = registry.create();
    expect(a).not.toBe(b);
    expect(registry.has(a)).toBe(true);
    expect(registry.has(b)).toBe(true);
    registry.stop(a);
    expect(registry.has(a)).toBe(false);
    expect(registry.has(b)).toBe(true);
    registry.stop_all();
  });

  it('append_audio/flush/stop/subscribe all report failure for an unknown id, never throw', async () => {
    const registry = create_mic_stream_registry({ sweepMs: 0, whisperRun: async () => '' });
    expect(registry.append_audio('nope', Buffer.alloc(4))).toBe(false);
    expect(await registry.flush('nope')).toBe(false);
    expect(registry.stop('nope')).toBe(false);
    expect(registry.subscribe('nope', () => {})).toBeNull();
    registry.stop_all();
  });
});

describe('create_mic_stream_registry: partial/final emission', () => {
  it('ticks emit growing partials with an IDENTICAL tStart across the whole open window', async () => {
    let call = 0;
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 15,
      windowCapMs: 100000,
      whisperRun: async () => {
        call += 1;
        return `text v${call}`;
      }
    });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));

    registry.append_audio(id, Buffer.alloc(3200)); // 100ms of 16kHz PCM16
    await wait_until(() => events.length >= 2);

    expect(events.every((e) => e.final === false)).toBe(true);
    const tStarts = new Set(events.map((e) => e.tStart));
    expect(tStarts.size).toBe(1); // byte-identical tStart across every partial this window

    registry.stop(id);
    registry.stop_all();
  });

  it('flush() emits a final event and resets the window (next partial gets a NEW tStart)', async () => {
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 15,
      windowCapMs: 100000,
      whisperRun: async () => 'the text'
    });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));

    registry.append_audio(id, Buffer.alloc(3200));
    await wait_until(() => events.length >= 1);
    const firstTStart = events[0].tStart;

    await registry.flush(id);
    const finalEvent = events[events.length - 1];
    expect(finalEvent.final).toBe(true);
    expect(finalEvent.text).toBe('the text');

    events.length = 0;
    registry.append_audio(id, Buffer.alloc(3200));
    await wait_until(() => events.length >= 1);
    expect(events[0].tStart).toBeGreaterThanOrEqual(firstTStart);
    expect(events[0].final).toBe(false);

    registry.stop(id);
    registry.stop_all();
  });

  it('flush() on an empty (never-appended) window emits an empty-text final without invoking whisperRun', async () => {
    let calls = 0;
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 15,
      whisperRun: async () => {
        calls += 1;
        return 'should not happen';
      }
    });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));

    await registry.flush(id);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ final: true, text: '' });
    expect(calls).toBe(0);

    registry.stop(id);
    registry.stop_all();
  });

  it('windowCapMs is a safety valve: an open window auto-finalizes and resets once it runs long enough, with no explicit flush', async () => {
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 15,
      windowCapMs: 40,
      whisperRun: async () => 'capped'
    });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));

    registry.append_audio(id, Buffer.alloc(3200));
    await wait_until(() => events.some((e) => e.final === true), 3000);

    registry.stop(id);
    registry.stop_all();
  });

  it('fires a fast, data-triggered first tick after firstWindowMs rather than waiting a full tickMs interval', async () => {
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 5000,
      firstWindowMs: 20,
      whisperRun: async () => 'fast first word'
    });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));

    const startedAt = Date.now();
    registry.append_audio(id, Buffer.alloc(3200));
    await wait_until(() => events.length >= 1, 500);

    expect(Date.now() - startedAt).toBeLessThan(300); // well under the 5000ms tickMs
    expect(events[0].text).toBe('fast first word');
    expect(events[0].final).toBe(false);

    registry.stop(id);
    registry.stop_all();
  });

  it('re-arms the fast first tick for a new window after flush() resets it', async () => {
    let call = 0;
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 5000,
      firstWindowMs: 20,
      whisperRun: async () => {
        call += 1;
        return `text v${call}`;
      }
    });
    const id = registry.create();
    /** @type {any[]} */
    const events = [];
    registry.subscribe(id, (e) => events.push(e));

    registry.append_audio(id, Buffer.alloc(3200));
    await wait_until(() => events.length >= 1);
    await registry.flush(id); // closes the first window, resets, re-arms

    events.length = 0;
    const restartedAt = Date.now();
    registry.append_audio(id, Buffer.alloc(3200));
    await wait_until(() => events.length >= 1, 500);
    expect(Date.now() - restartedAt).toBeLessThan(300);

    registry.stop(id);
    registry.stop_all();
  });

  it('a burst of appends within the same window schedules only one fast first tick', async () => {
    let calls = 0;
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 5000,
      firstWindowMs: 30,
      whisperRun: async () => {
        calls += 1;
        return 'x';
      }
    });
    const id = registry.create();
    registry.subscribe(id, () => {});

    registry.append_audio(id, Buffer.alloc(320));
    registry.append_audio(id, Buffer.alloc(320));
    registry.append_audio(id, Buffer.alloc(320));
    await new Promise((r) => setTimeout(r, 150));

    expect(calls).toBe(1);

    registry.stop(id);
    registry.stop_all();
  });

  it('the sliding window drops old bytes once maxWindowBytes is exceeded (whisperRun never sees an ever-growing buffer)', async () => {
    /** @type {number[]} */
    const sizesSeen = [];
    const registry = create_mic_stream_registry({
      sweepMs: 0,
      tickMs: 15,
      windowCapMs: 100000,
      maxWindowBytes: 4000,
      whisperRun: async (wav) => {
        sizesSeen.push(wav.length - 44); // strip the WAV header
        return 'x';
      }
    });
    const id = registry.create();
    registry.subscribe(id, () => {});

    for (let i = 0; i < 6; i++) {
      registry.append_audio(id, Buffer.alloc(2000));
      await new Promise((r) => setTimeout(r, 20));
    }
    await wait_until(() => sizesSeen.length >= 4);

    expect(Math.max(...sizesSeen)).toBeLessThanOrEqual(4000);

    registry.stop(id);
    registry.stop_all();
  });
});
