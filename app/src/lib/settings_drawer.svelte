<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — settings drawer (Task 6): the content of the hidden top
  // bar below the header row (wordmark/title/clock/gear). Session identity
  // fields (L/R names) mutate the live SessionStore via callbacks — same
  // store-agnostic convention as every other component here. Everything
  // else (AI toggles/principles, model names, summary interval, engine,
  // replay speed) mutates the passed-in `SettingsStore` directly — see
  // settings_store.svelte.ts's header comment for why that one instance is
  // passed whole rather than unpacked into a callback per field.

  import type { Speaker } from '../../../shared/model';
  import type { SettingsStore } from './settings_store.svelte';
  import { fetch_whisper_status, mic_option_label, mic_ready, type WhisperStatus } from './whisper_status';

  let {
    names,
    onnameschange,
    settings
  }: {
    names: { L: string; R: string };
    onnameschange: (patch: Partial<{ L: string; R: string }>) => void;
    settings: SettingsStore;
  } = $props();

  const SIDES: Speaker[] = ['L', 'R'];

  // v0.2 (DEVLOG/v02-live-transcription_of-talkweave_handover.md): the
  // 'mic' option is now REAL and enabled once the server's chosen ASR
  // engine is actually usable (binary/proxy AND model both present); see
  // mic_engine.ts's real implementation and session_mode_plan.ts's
  // `startMic` gating. Three states, distinguished by `fetch_whisper_
  // status`'s richer response (server/lib/whisper_stream.mjs's
  // `check_whisper_availability`, or the qwen-asr-engine handover's
  // equivalent probe) rather than a single boolean: engine missing,
  // engine-found-but-not-ready, and fully ready. `mic_option_label`
  // (whisper_status.ts) names the actual engine in each case rather than
  // assuming whisper, since qwen-asr-engine adds a second possible
  // backend. Starts at the conservative "not available" state until the
  // fetch settles.
  let whisperStatus = $state<WhisperStatus>({
    available: false,
    bin: 'whisper-cli',
    model: '',
    modelPresent: false,
    engine: null,
    detail: null
  });
  void fetch_whisper_status().then((status) => {
    whisperStatus = status;
  });
  let micReady = $derived(mic_ready(whisperStatus));
  let micLabel = $derived(mic_option_label(whisperStatus));
</script>

<div class="drawer">
  <section class="row names">
    <label class="field">
      <span class="label">left name</span>
      <input
        type="text"
        value={names.L}
        oninput={(e) => onnameschange({ L: e.currentTarget.value })}
      />
    </label>
    <label class="field">
      <span class="label">right name</span>
      <input
        type="text"
        value={names.R}
        oninput={(e) => onnameschange({ R: e.currentTarget.value })}
      />
    </label>
  </section>

  <section class="row ai-master">
    <label class="checkbox-field">
      <input
        type="checkbox"
        checked={settings.settings.aiEnabled}
        onchange={(e) => settings.set_ai_enabled(e.currentTarget.checked)}
      />
      <span class="label">AI suggestions</span>
    </label>
  </section>

  <section class="row per-person">
    {#each SIDES as side (side)}
      <div class="person-block">
        <label class="checkbox-field">
          <input
            type="checkbox"
            checked={settings.settings.ai[side].enabled}
            onchange={(e) => settings.set_person_ai_enabled(side, e.currentTarget.checked)}
          />
          <span class="label">{side === 'L' ? names.L || 'left' : names.R || 'right'} AI</span>
        </label>
        <textarea
          class="principles"
          rows="2"
          placeholder="principles for {side === 'L' ? names.L || 'left' : names.R || 'right'}'s suggestions…"
          value={settings.settings.ai[side].principles}
          oninput={(e) => settings.set_person_principles(side, e.currentTarget.value)}
        ></textarea>
      </div>
    {/each}
  </section>

  <section class="row models">
    <label class="field">
      <span class="label">quick model</span>
      <input
        type="text"
        value={settings.settings.models.quick}
        oninput={(e) => settings.set_model('quick', e.currentTarget.value)}
      />
    </label>
    <label class="field">
      <span class="label">deep model</span>
      <input
        type="text"
        value={settings.settings.models.deep}
        oninput={(e) => settings.set_model('deep', e.currentTarget.value)}
      />
    </label>
    <label class="field">
      <span class="label">claim model</span>
      <input
        type="text"
        value={settings.settings.models.claim}
        oninput={(e) => settings.set_model('claim', e.currentTarget.value)}
      />
    </label>
  </section>

  <section class="row misc">
    <label class="field">
      <span class="label">summary interval (min, 0=off)</span>
      <input
        type="number"
        min="0"
        step="1"
        value={settings.settings.summaryIntervalMinutes}
        oninput={(e) => settings.set_summary_interval_minutes(e.currentTarget.valueAsNumber)}
      />
    </label>
    <label class="field">
      <span class="label">engine</span>
      <select
        value={settings.settings.engine}
        onchange={(e) => settings.set_engine(e.currentTarget.value === 'mic' ? 'mic' : 'replay')}
      >
        <option value="replay">replay</option>
        <option value="mic" disabled={!micReady}>{micLabel}</option>
      </select>
    </label>
    <label class="field">
      <span class="label">replay speed (0.5-8x)</span>
      <input
        type="number"
        min="0.5"
        max="8"
        step="0.25"
        value={settings.settings.replaySpeed}
        oninput={(e) => settings.set_replay_speed(e.currentTarget.valueAsNumber)}
      />
    </label>
  </section>
</div>

<style>
  .drawer {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 20px 18px;
    border-top: 1px solid #1a1a1a;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  .label {
    color: #6a6a66;
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  input[type='text'],
  input[type='number'],
  select,
  textarea {
    background: #0a0a0a;
    border: 1px solid #2a2a26;
    color: #e8e8e4;
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
  }

  input[type='text']:focus,
  input[type='number']:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: #ffb84d;
  }

  input[type='number'] {
    width: 90px;
  }

  .checkbox-field {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #e8e8e4;
  }

  .per-person {
    align-items: flex-start;
  }

  .person-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1 1 260px;
    min-width: 200px;
  }

  .principles {
    resize: none;
    width: 100%;
    line-height: 1.4;
  }

  .principles::placeholder {
    color: #4a4a46;
  }
</style>
