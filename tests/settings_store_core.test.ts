// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  create_memory_settings_storage,
  default_settings,
  load_settings,
  merge_settings,
  save_settings,
  SETTINGS_STORAGE_KEY,
  ENGINE_DEFAULT_MIGRATION_KEY,
  type SettingsStorage
} from '../app/src/lib/settings_store_core';

describe('settings_store_core: default_settings', () => {
  it('matches the brief\'s documented defaults', () => {
    const s = default_settings();
    expect(s.aiEnabled).toBe(true);
    expect(s.ai.L).toEqual({ enabled: true, principles: '' });
    expect(s.ai.R).toEqual({ enabled: true, principles: '' });
    expect(s.models).toEqual({ quick: 'qwen3:4b', deep: 'qwen3.6-27b-iq4:latest', claim: 'qwen3:4b' });
    expect(s.summaryIntervalMinutes).toBe(15);
    expect(s.engine).toBe('mic');
    expect(s.replaySpeed).toBe(1);
  });

  it('returns a fresh object each call (no shared-reference mutation)', () => {
    const a = default_settings();
    const b = default_settings();
    a.ai.L.principles = 'mutated';
    expect(b.ai.L.principles).toBe('');
    expect(a).not.toBe(b);
    expect(a.ai).not.toBe(b.ai);
  });
});

describe('settings_store_core: merge_settings', () => {
  it('returns defaults for non-object stored values (null, array, primitives)', () => {
    for (const bad of [null, undefined, [], 'x', 3, true]) {
      expect(merge_settings(bad)).toEqual(default_settings());
    }
  });

  it('returns defaults for an empty object', () => {
    expect(merge_settings({})).toEqual(default_settings());
  });

  it('merges a full valid partial straight through', () => {
    const stored = {
      aiEnabled: false,
      ai: { L: { enabled: false, principles: 'be terse' }, R: { enabled: true, principles: 'be warm' } },
      models: { quick: 'llama3:8b', deep: 'llama3:70b', claim: 'llama3:8b' },
      summaryIntervalMinutes: 5,
      engine: 'mic',
      replaySpeed: 2
    };
    expect(merge_settings(stored)).toEqual(stored);
  });

  it('keeps unspecified nested fields at their defaults (partial ai.L only)', () => {
    const merged = merge_settings({ ai: { L: { enabled: false } } });
    expect(merged.ai.L).toEqual({ enabled: false, principles: '' });
    expect(merged.ai.R).toEqual({ enabled: true, principles: '' });
    expect(merged.aiEnabled).toBe(true);
    expect(merged.models).toEqual(default_settings().models);
  });

  it('falls back to default for a bad engine value instead of accepting it', () => {
    expect(merge_settings({ engine: 'banana' }).engine).toBe('mic');
    expect(merge_settings({ engine: 123 }).engine).toBe('mic');
    expect(merge_settings({ engine: 'mic' }).engine).toBe('mic');
  });

  it('falls back to default for wrong-typed / invalid numbers', () => {
    expect(merge_settings({ summaryIntervalMinutes: '15' }).summaryIntervalMinutes).toBe(15);
    expect(merge_settings({ summaryIntervalMinutes: -5 }).summaryIntervalMinutes).toBe(15);
    expect(merge_settings({ summaryIntervalMinutes: NaN }).summaryIntervalMinutes).toBe(15);
    expect(merge_settings({ summaryIntervalMinutes: 0 }).summaryIntervalMinutes).toBe(0);
    expect(merge_settings({ replaySpeed: 'fast' }).replaySpeed).toBe(1);
    expect(merge_settings({ replaySpeed: -1 }).replaySpeed).toBe(1);
  });

  it('falls back to default for wrong-typed booleans/strings', () => {
    expect(merge_settings({ aiEnabled: 'yes' }).aiEnabled).toBe(true);
    expect(merge_settings({ models: { quick: 42 } }).models.quick).toBe('qwen3:4b');
  });

  it('ignores unknown extra keys without crashing', () => {
    const merged = merge_settings({ somethingUnexpected: { deeply: { nested: true } }, engine: 'mic' });
    expect(merged.engine).toBe('mic');
    expect((merged as Record<string, unknown>).somethingUnexpected).toBeUndefined();
  });

  it('tolerates a non-object ai/models sub-value by falling back to defaults for it', () => {
    const merged = merge_settings({ ai: 'not-an-object', models: 42 });
    expect(merged.ai).toEqual(default_settings().ai);
    expect(merged.models).toEqual(default_settings().models);
  });
});

describe('settings_store_core: load_settings / save_settings via a fake storage (injection seam)', () => {
  function fake_storage(): SettingsStorage {
    return create_memory_settings_storage();
  }

  it('loads defaults when nothing is stored', () => {
    expect(load_settings(fake_storage())).toEqual(default_settings());
  });

  it('loads defaults for malformed JSON rather than throwing', () => {
    const storage = fake_storage();
    storage.set(SETTINGS_STORAGE_KEY, '{not valid json');
    expect(load_settings(storage)).toEqual(default_settings());
  });

  it('round-trips a save/load cycle', () => {
    const storage = fake_storage();
    const settings = default_settings();
    settings.engine = 'mic';
    settings.models.quick = 'custom-model';
    settings.ai.L.principles = 'be concise';
    save_settings(storage, settings);
    expect(load_settings(storage)).toEqual(settings);
  });

  it('persists under the documented storage key', () => {
    const storage = fake_storage();
    save_settings(storage, default_settings());
    expect(storage.get(SETTINGS_STORAGE_KEY)).not.toBeNull();
    expect(JSON.parse(storage.get(SETTINGS_STORAGE_KEY) as string)).toEqual(default_settings());
  });

  it('merges a stored partial (forward-compatible with an older schema) on load', () => {
    const storage = fake_storage();
    storage.set(SETTINGS_STORAGE_KEY, JSON.stringify({ summaryIntervalMinutes: 30 }));
    const loaded = load_settings(storage);
    expect(loaded.summaryIntervalMinutes).toBe(30);
    expect(loaded.engine).toBe('mic');
    expect(loaded.models).toEqual(default_settings().models);
  });
});

describe('engine default migration to mic (v0.3)', () => {
  function fake_storage(initial: Record<string, string> = {}): SettingsStorage {
    const storage = create_memory_settings_storage();
    for (const [k, v] of Object.entries(initial)) storage.set(k, v);
    return storage;
  }

  it('defaults a fresh install to mic', () => {
    const storage = fake_storage();
    expect(load_settings(storage).engine).toBe('mic');
  });

  it('moves a stored replay to mic exactly once', () => {
    const storage = fake_storage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ ...default_settings(), engine: 'replay' })
    });
    expect(load_settings(storage).engine).toBe('mic');
    // A deliberate choice of replay after the migration must survive.
    save_settings(storage, { ...default_settings(), engine: 'replay' });
    expect(load_settings(storage).engine).toBe('replay');
  });

  it('leaves a stored mic alone', () => {
    const storage = fake_storage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ ...default_settings(), engine: 'mic' })
    });
    expect(load_settings(storage).engine).toBe('mic');
  });

  it('marks the migration done even when there is nothing stored', () => {
    const storage = fake_storage();
    load_settings(storage);
    expect(storage.get(ENGINE_DEFAULT_MIGRATION_KEY)).not.toBeNull();
  });
});
