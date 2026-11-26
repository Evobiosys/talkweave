// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — Svelte 5 runes-based settings store (Task 6).
//
// Thin reactive shell over settings_store_core.ts, same split as
// session_store.svelte.ts / session_store_core.ts: all the actual
// defaults/merge/persist logic lives in the plain-TS core module so it's
// unit-testable under vitest (no @sveltejs/vite-plugin-svelte wired into
// vitest.config.ts — `$state` doesn't compile outside a real Svelte
// pipeline). This class just holds `settings` as `$state` and calls into
// core on every mutation.
//
// One `SettingsStore` instance is constructed by app.svelte (same pattern
// as `SessionStore`) and passed as a single prop into settings_drawer.svelte
// / session_header.svelte, rather than app.svelte unpacking it into ~10
// individual callbacks. That's a deliberate, narrower exception to
// side_panel.svelte's "store-agnostic components, app.svelte is the only
// place that wires a store" rule: side_panel.svelte's SessionStore carries
// real branching mutation logic worth keeping out of markup, where every
// settings field here is a trivial "set this one property, then persist"
// with no decision-making of its own (the actual logic worth testing —
// defaults/merge/validation/persist — already lives in, and is fully
// covered by tests against, settings_store_core.ts without any component
// involved). SessionStore itself still flows through app.svelte only.

import {
  create_local_storage_settings_storage,
  default_settings,
  load_settings,
  save_settings,
  type Engine,
  type Settings,
  type SettingsStorage
} from './settings_store_core';

export class SettingsStore {
  settings: Settings = $state(default_settings());

  private storage: SettingsStorage;

  constructor(storage: SettingsStorage = create_local_storage_settings_storage()) {
    this.storage = storage;
    this.settings = load_settings(storage);
  }

  private persist(): void {
    save_settings(this.storage, this.settings);
  }

  set_ai_enabled(enabled: boolean): void {
    this.settings.aiEnabled = enabled;
    this.persist();
  }

  set_person_ai_enabled(side: 'L' | 'R', enabled: boolean): void {
    this.settings.ai[side].enabled = enabled;
    this.persist();
  }

  set_person_principles(side: 'L' | 'R', principles: string): void {
    this.settings.ai[side].principles = principles;
    this.persist();
  }

  set_model(kind: 'quick' | 'deep' | 'claim', name: string): void {
    this.settings.models[kind] = name;
    this.persist();
  }

  set_summary_interval_minutes(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes < 0) return;
    this.settings.summaryIntervalMinutes = minutes;
    this.persist();
  }

  set_engine(engine: Engine): void {
    this.settings.engine = engine;
    this.persist();
  }

  set_replay_speed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0) return;
    this.settings.replaySpeed = speed;
    this.persist();
  }
}
