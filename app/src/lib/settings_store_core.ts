// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — pure settings defaults/merge/persist logic (Task 6).
//
// Framework-free (no runes), same rationale as session_store_core.ts: kept
// separate from settings_store.svelte.ts so it's directly unit-testable
// under plain vitest without the svelte plugin.
//
// Scope (task-6-brief.md): AI master toggle, per-person AI suggestion
// toggle + "principles" textarea, model names (quick/deep/claim), summary
// interval minutes (0 = off), engine selector (replay/mic — wired in
// Task 8), replay speed. This module only *stores* those values — engines
// themselves are Task 8's job, AI toggles/principles are consumed by
// Task 9's pipeline (YAGNI: no engine/LLM code belongs here).
//
// Session-identity fields (`names`, `title`) deliberately do NOT live
// here: `shared/model.ts`'s `Session.names`/`Session.title` are already
// part of the markdown source of truth (see session_store_core.ts's
// `set_names`/`set_title`, added alongside this file for Task 6). Mirroring
// them into localStorage too would create a second, driftable source for
// the same data — the settings drawer edits `Session` fields for those two,
// and this `Settings` shape for everything else.

export interface PersonAiSettings {
  enabled: boolean;
  /** Free-text guidance for that person's AI suggestions (2-row textarea
   *  in the drawer). Empty string, not null — always a valid string to
   *  bind an input's value to. */
  principles: string;
}

export type Engine = 'replay' | 'mic';

export interface Settings {
  aiEnabled: boolean;
  ai: { L: PersonAiSettings; R: PersonAiSettings };
  models: { quick: string; deep: string; claim: string };
  /** Minutes between auto-summaries; 0 = off. */
  summaryIntervalMinutes: number;
  engine: Engine;
  replaySpeed: number;
}

export const SETTINGS_STORAGE_KEY = 'talkweave.settings.v1';

/**
 * One-time marker for the v0.3 default flip. Until live transcription
 * actually worked, `engine` defaulted to `'replay'` and the mic option was
 * unselectable, so every existing user has `'replay'` persisted whether or
 * not they ever chose it. Flipping the default alone would therefore change
 * nothing for exactly the people who have been waiting for it. This key
 * records that the flip has been applied once, so a later deliberate choice
 * of `'replay'` is never overridden a second time.
 */
export const ENGINE_DEFAULT_MIGRATION_KEY = 'talkweave.engineDefault.v3';

const DEFAULT_SUMMARY_INTERVAL_MINUTES = 15;
const DEFAULT_REPLAY_SPEED = 1;
const DEFAULT_QUICK_MODEL = 'qwen3:4b';
const DEFAULT_DEEP_MODEL = 'qwen3.6-27b-iq4:latest';
const DEFAULT_CLAIM_MODEL = 'qwen3:4b';

function default_person_ai(): PersonAiSettings {
  return { enabled: true, principles: '' };
}

/** Fresh defaults object every call — callers mutate the result freely
 *  without risk of corrupting a shared module-level default. */
export function default_settings(): Settings {
  return {
    aiEnabled: true,
    ai: { L: default_person_ai(), R: default_person_ai() },
    models: { quick: DEFAULT_QUICK_MODEL, deep: DEFAULT_DEEP_MODEL, claim: DEFAULT_CLAIM_MODEL },
    summaryIntervalMinutes: DEFAULT_SUMMARY_INTERVAL_MINUTES,
    engine: 'mic',
    replaySpeed: DEFAULT_REPLAY_SPEED
  };
}

function is_record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge_bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function merge_string(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Finite, non-negative number, else `fallback`. Covers both malformed
 *  types (a string, `NaN`, `Infinity`) and out-of-range values (a negative
 *  interval/speed makes no sense) in one guard. */
function merge_nonneg_number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function merge_engine(value: unknown, fallback: Engine): Engine {
  return value === 'replay' || value === 'mic' ? value : fallback;
}

function merge_person_ai(value: unknown, fallback: PersonAiSettings): PersonAiSettings {
  const v = is_record(value) ? value : {};
  return {
    enabled: merge_bool(v.enabled, fallback.enabled),
    principles: merge_string(v.principles, fallback.principles)
  };
}

/**
 * Merges a partial, untrusted (possibly attacker- or hand-edited)
 * `stored` value over `default_settings()`, field by field with type/enum
 * validation — never a blind `{...defaults, ...stored}` spread, which
 * would let a malformed `localStorage` value (wrong type, stale schema,
 * hand-edited JSON) leak invalid data — e.g. `engine: "banana"` or
 * `summaryIntervalMinutes: "15"` — straight into the live store. Missing
 * or invalid fields (including entirely missing nested objects) fall back
 * to the matching default field individually, so a partial stored object
 * from an older schema version stays forward-compatible: unrecognised
 * extra keys are simply ignored, never a source of error.
 */
export function merge_settings(stored: unknown): Settings {
  const defaults = default_settings();
  if (!is_record(stored)) return defaults;

  const aiRaw = is_record(stored.ai) ? stored.ai : {};
  const modelsRaw = is_record(stored.models) ? stored.models : {};

  return {
    aiEnabled: merge_bool(stored.aiEnabled, defaults.aiEnabled),
    ai: {
      L: merge_person_ai(aiRaw.L, defaults.ai.L),
      R: merge_person_ai(aiRaw.R, defaults.ai.R)
    },
    models: {
      quick: merge_string(modelsRaw.quick, defaults.models.quick),
      deep: merge_string(modelsRaw.deep, defaults.models.deep),
      claim: merge_string(modelsRaw.claim, defaults.models.claim)
    },
    summaryIntervalMinutes: merge_nonneg_number(stored.summaryIntervalMinutes, defaults.summaryIntervalMinutes),
    engine: merge_engine(stored.engine, defaults.engine),
    replaySpeed: merge_nonneg_number(stored.replaySpeed, defaults.replaySpeed)
  };
}

/**
 * Minimal storage seam settings_store.svelte.ts depends on instead of
 * `window.localStorage` directly, so both the load/save logic below and
 * (via a fake implementation) the reactive wrapper are testable without a
 * DOM/localStorage global (this project's vitest config has no jsdom — see
 * session_store_core.ts's header comment for the precedent). Synchronous,
 * matching `Storage`'s own interface.
 */
export interface SettingsStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * Wraps the real `localStorage` global, defensively: a throwing accessor
 * (private-browsing quota errors, disabled storage, non-browser test
 * environments where `localStorage` doesn't exist at all) must never take
 * down the settings drawer — it degrades to "nothing persists this
 * session" rather than crashing.
 */
export function create_local_storage_settings_storage(): SettingsStorage {
  return {
    get(key: string): string | null {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
      } catch {
        // Storage unavailable/full/blocked: settings stay in-memory only
        // for this session. Not surfaced to the UI (YAGNI — no toast/error
        // path specified by the brief for this edge case).
      }
    }
  };
}

/** In-memory `SettingsStorage`, for tests and as a last-resort fallback. */
export function create_memory_settings_storage(): SettingsStorage {
  const data = new Map<string, string>();
  return {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    }
  };
}

/**
 * Loads settings from `storage`, merged over defaults. Malformed JSON (or
 * no stored value at all) falls back to `default_settings()` rather than
 * throwing.
 */
export function load_settings(storage: SettingsStorage): Settings {
  const raw = storage.get(SETTINGS_STORAGE_KEY);
  if (raw === null) {
    storage.set(ENGINE_DEFAULT_MIGRATION_KEY, 'done');
    return default_settings();
  }
  let merged: Settings;
  try {
    merged = merge_settings(JSON.parse(raw));
  } catch {
    storage.set(ENGINE_DEFAULT_MIGRATION_KEY, 'done');
    return default_settings();
  }
  return apply_engine_default_migration(storage, merged);
}

/**
 * Moves a stored `'replay'` to `'mic'` exactly once. `'replay'` was the old
 * default and could not be changed through the UI, so its presence says
 * nothing about intent. After this runs once the marker is set and a user
 * who genuinely prefers the demo replay keeps it forever.
 */
export function apply_engine_default_migration(
  storage: SettingsStorage,
  settings: Settings
): Settings {
  if (storage.get(ENGINE_DEFAULT_MIGRATION_KEY) !== null) return settings;
  storage.set(ENGINE_DEFAULT_MIGRATION_KEY, 'done');
  if (settings.engine !== 'replay') return settings;
  const migrated: Settings = { ...settings, engine: 'mic' };
  save_settings(storage, migrated);
  return migrated;
}

/** Persists `settings` to `storage` as JSON. */
export function save_settings(storage: SettingsStorage, settings: Settings): void {
  storage.set(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
