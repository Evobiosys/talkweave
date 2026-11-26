<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — session header (Task 6), lives inside app.svelte's top bar
  // alongside the wordmark: editable title, elapsed clock `hh:mm:ss`,
  // recording dot.
  //
  // Store-agnostic (same convention as side_panel.svelte /
  // transcript_view.svelte): plain props + a callback, no SessionStore
  // import here — app.svelte wires `title`/`ontitlechange` to
  // `store.session.title` / `store.set_title`.
  //
  // Owns its own ticking clock: `session_elapsed_seconds(startedAt)` is a
  // pure snapshot (see session_clock.ts), so something has to re-read it on
  // an interval for the displayed time to actually move. Kept local to
  // this component (a `$effect`-scoped `setInterval`, cleaned up on
  // unmount) rather than adding a ticking `$state` to app.svelte, since
  // nothing else in the shell needs "wall-clock tick" as shared state.

  import { format_hms, session_elapsed_seconds } from './session_clock';

  let {
    title,
    ontitlechange,
    startedAt,
    recording
  }: {
    title: string;
    ontitlechange: (title: string) => void;
    startedAt: string;
    /** Task 7's recording-in-progress boolean — see session_store.svelte.ts's
     *  `recording` field doc comment for the contract. Defaults false there,
     *  so this dot renders inert (dim, non-pulsing) until Task 7 wires audio. */
    recording: boolean;
  } = $props();

  const TICK_MS = 1000;

  // Initialized to 0, not `session_elapsed_seconds(startedAt)` — a `$state`
  // initializer only ever captures its *initial* value even when the
  // expression references reactive props (svelte-check's
  // `state_referenced_locally` warning), so the real first read happens
  // synchronously inside the `$effect` below instead, alongside the
  // interval that keeps it ticking.
  let elapsed = $state(0);

  $effect(() => {
    elapsed = session_elapsed_seconds(startedAt);
    const id = setInterval(() => {
      elapsed = session_elapsed_seconds(startedAt);
    }, TICK_MS);
    return () => clearInterval(id);
  });
</script>

<div class="session-header">
  <input
    class="title-input"
    type="text"
    value={title}
    placeholder="untitled conversation"
    oninput={(e) => ontitlechange(e.currentTarget.value)}
    onkeydown={(e) => {
      if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur();
    }}
  />
  <span class="clock">{format_hms(elapsed)}</span>
  <span class="rec-dot" class:active={recording} title={recording ? 'recording' : 'not recording'}></span>
</div>

<style>
  .session-header {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
    justify-content: center;
  }

  .title-input {
    background: none;
    border: none;
    color: #e8e8e4;
    font-size: 13px;
    text-align: center;
    padding: 2px 6px;
    max-width: 360px;
    min-width: 0;
    border-bottom: 1px solid transparent;
  }

  .title-input::placeholder {
    color: #4a4a46;
  }

  .title-input:hover,
  .title-input:focus {
    border-bottom-color: #3a3a36;
    outline: none;
  }

  .clock {
    color: #6a6a66;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .rec-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #3a3a36;
    flex-shrink: 0;
  }

  .rec-dot.active {
    background: #ffb84d;
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
</style>
