<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — Task 10's fact-check trigger UI: a minimal, centered,
  // single-line prompt. Opened by app.svelte on the `F` key (suppressed
  // while typing, same `is_typing_target` gate as every other global key —
  // see app.svelte's `handle_keydown`) or a top-bar button, pre-filled with
  // the latest flagged claim (editable). Enter dispatches; Escape cancels.
  //
  // Store-agnostic by design (same pattern as side_panel.svelte /
  // transcript_view.svelte): takes the pre-fill text as a plain prop and
  // reports back via callback props, so app.svelte stays the one place
  // that decides what "dispatch" actually does (start the SSE stream, add
  // the pending card, etc).

  import { tick } from 'svelte';

  let {
    initialText,
    fromSelection = false,
    onsubmit,
    oncancel
  }: {
    initialText: string;
    /** True when `initialText` came from a highlighted transcript
     *  passage rather than the latest flag (app.svelte's F-key
     *  selection-vs-flag prefill). Changes only the label text below —
     *  same visual idiom as the default "fact-check" label, no new one
     *  introduced — so the user can tell at a glance which source is
     *  about to be sent, per task brief requirement 6. */
    fromSelection?: boolean;
    onsubmit: (question: string) => void;
    oncancel: () => void;
  } = $props();

  // Initialized to '', not `initialText` — a `$state` initializer only
  // ever captures its *initial* value even when the expression references
  // a reactive prop (svelte-check's `state_referenced_locally` warning),
  // same pattern as session_header.svelte's `elapsed`. The real first read
  // happens synchronously inside the mount `$effect` below instead, which
  // is only ever entered once per prompt open (this component is
  // destroyed+recreated by app.svelte's `{#if factcheckPromptOpen}` on
  // every open, never reused with a changed `initialText`).
  let text = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    text = initialText;
    // Waits for the DOM update `text = initialText` just triggered to
    // actually flush before selecting — selecting synchronously here would
    // still see the stale (empty) `<input>` value from the prior render.
    void tick().then(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });

  function handle_keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onsubmit(trimmed);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      oncancel();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- a
     plain click-outside-to-cancel backdrop; the input itself is the real
     interactive element and already handles Escape. -->
<div class="backdrop" onclick={oncancel}>
  <div class="prompt-box" onclick={(e) => e.stopPropagation()}>
    <span class="label">{fromSelection ? 'fact-check selection' : 'fact-check'}</span>
    <input
      bind:this={inputEl}
      bind:value={text}
      class="prompt-input"
      type="text"
      placeholder="what should be checked?"
      onkeydown={handle_keydown}
    />
    <span class="hint">enter to dispatch · esc to cancel</span>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 18vh;
    background: rgba(0, 0, 0, 0.55);
  }

  .prompt-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: min(560px, 86vw);
  }

  .label {
    color: #6a6a66;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .prompt-input {
    width: 100%;
    background: #000;
    border: none;
    border-bottom: 1px solid #3a3a36;
    color: #e8e8e4;
    font-size: 18px;
    font-family: inherit;
    text-align: center;
    padding: 6px 4px 10px;
  }

  .prompt-input::placeholder {
    color: #4a4a46;
  }

  .prompt-input:focus {
    outline: none;
    border-bottom-color: #e8e8e4;
  }

  .hint {
    color: #4a4a46;
    font-size: 10px;
    letter-spacing: 0.03em;
  }
</style>
