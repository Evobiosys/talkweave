<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — "ask the conversation about itself" trigger UI
  // (ask-the-conversation handover, part 2). Same minimal centered-
  // backdrop idiom as factcheck_prompt.svelte, not a second one: opened
  // by app.svelte on the `A` key (suppressed while typing, same
  // `is_typing_target` gate every other global key uses), Escape cancels.
  //
  // Two presets act on `passage` (the highlighted transcript text, or —
  // when there is no usable highlight — the latest-flag excerpt, same
  // "selection wins, flag is the fallback, never a dead state" rule `F`
  // already established); the free-form question is always available,
  // independent of whether a usable passage exists at all. Store-
  // agnostic by design (same pattern as factcheck_prompt.svelte):
  // app.svelte owns retrieval + dispatch, this component only reports
  // back via callback props.

  import { tick } from 'svelte';

  let {
    passage,
    fromSelection = false,
    onrecall,
    oncontradiction,
    onfreeform,
    oncancel
  }: {
    /** The passage the two presets act on — `null` when there is neither
     *  a usable highlight nor any flag yet to fall back to (the presets
     *  are hidden in that case; free-form asking still works). */
    passage: string | null;
    fromSelection?: boolean;
    onrecall: (passage: string) => void;
    oncontradiction: (passage: string) => void;
    onfreeform: (question: string) => void;
    oncancel: () => void;
  } = $props();

  let question = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    void tick().then(() => {
      inputEl?.focus();
    });
  });

  function handle_keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const trimmed = question.trim();
      if (trimmed) onfreeform(trimmed);
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
    <span class="label">ask the conversation</span>

    {#if passage}
      <p class="passage" class:from-selection={fromSelection}>“{passage}”</p>
      <div class="preset-row">
        <button type="button" class="preset-btn" onclick={() => onrecall(passage)}>did we talk about this before?</button>
        <button type="button" class="preset-btn" onclick={() => oncontradiction(passage)}>was this contradicted elsewhere?</button>
      </div>
    {/if}

    <input
      bind:this={inputEl}
      bind:value={question}
      class="prompt-input"
      type="text"
      placeholder="ask anything about this conversation…"
      onkeydown={handle_keydown}
    />
    <span class="hint">enter to ask · esc to cancel</span>
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

  .passage {
    color: #8a8a86;
    font-size: 13px;
    line-height: 1.4;
    text-align: center;
    margin: 0;
  }

  .passage.from-selection {
    color: #b8b8b4;
  }

  .preset-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .preset-btn {
    background: none;
    border: 1px solid #3a3a36;
    color: #d8d8d4;
    font-size: 11px;
    padding: 6px 12px;
    border-radius: 999px;
    cursor: pointer;
  }

  .preset-btn:hover {
    border-color: #e8e8e4;
    color: #e8e8e4;
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
