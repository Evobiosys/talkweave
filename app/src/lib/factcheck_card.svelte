<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — Task 10's docked fact-check card: quick answer, then a
  // live countdown for the deeper look, then the deep result (a red-tinted
  // border + nuance line on contradiction, a quiet agreement line
  // otherwise). Docked above the bottom bar, right side (see app.svelte's
  // `.factcheck-stack`). Store-agnostic (same pattern as side_panel.svelte
  // / transcript_view.svelte): takes a plain `FactCheckCardState` (Task
  // 10's `factcheck_reducer.ts`) plus callback props; app.svelte owns the
  // actual reducer dispatch and SSE wiring.
  //
  // Color discipline (global-constraints.md): the contradiction border/⚠
  // is the ONLY use of #ff6b6b here — everything else stays white/off-
  // white/gray, no amber (amber is reserved for flags).

  import type { FactCheckCardState } from './factcheck_reducer';

  let {
    card,
    expanded,
    ondismiss,
    onkeep
  }: {
    card: FactCheckCardState;
    expanded: boolean;
    ondismiss: (id: string) => void;
    onkeep: (id: string) => void;
  } = $props();

  // Live countdown: re-armed (fresh `Date.now()` anchor) every time this
  // card transitions INTO 'deep_running' — reading `card.status`/
  // `card.etaMs` inside the effect body is what makes Svelte re-run it on
  // exactly that transition. The cleanup (returned closure) clears the
  // previous interval before the effect body re-runs for any later
  // transition (e.g. into 'deep_done'), so no interval ever outlives the
  // state it was counting down for.
  let remainingMs = $state(0);

  $effect(() => {
    if (card.status !== 'deep_running' || card.etaMs === null) return;
    const startedAt = Date.now();
    const etaMs = card.etaMs;
    remainingMs = etaMs;
    const id = setInterval(() => {
      remainingMs = Math.max(0, startedAt + etaMs - Date.now());
    }, 250);
    return () => clearInterval(id);
  });

  const remainingSeconds = $derived(Math.ceil(remainingMs / 1000));
</script>

<div
  class="card"
  class:collapsed={!expanded}
  class:contradicts={card.status === 'deep_done' && card.deep?.contradicts === true}
>
  {#if expanded}
    <p class="question">{card.question}</p>

    {#if card.quick}
      <div class="quick-row">
        <span class="quick-text">{card.quick.text || '(no answer)'}</span>
        <span class="chip">{card.quick.model}</span>
      </div>
    {/if}

    {#if card.status === 'deep_running'}
      <p class="deep-pending">deeper look — ~{remainingSeconds}s</p>
    {:else if card.status === 'deep_done' && card.deep}
      {#if card.deep.contradicts}
        <p class="deep-warning">⚠ {card.deep.nuance || 'the deeper look differs from the quick answer.'}</p>
      {:else}
        <p class="deep-agree">✓ deep agrees</p>
      {/if}
    {/if}

    <div class="actions">
      <button type="button" class="action-btn" onclick={() => ondismiss(card.id)}>dismiss</button>
      <button type="button" class="action-btn" onclick={() => onkeep(card.id)} disabled={card.kept}>
        {card.kept ? 'kept' : 'keep'}
      </button>
    </div>
  {:else}
    <!-- Collapsed = just a recency-aged-out older card (or a settled
         dismissed/kept one) shown as a quiet strip — no click affordance
         of its own; task-10-brief.md gives collapsed cards no re-expand
         interaction, so this is display-only (a `title` tooltip is the
         only way to read the full question without it expanding). -->
    <div class="collapsed-row" title={card.question}>
      <span class="collapsed-question">{card.question}</span>
    </div>
  {/if}
</div>

<style>
  .card {
    width: 280px;
    background: #0a0a0a;
    border: 1px solid #2a2a26;
    border-radius: 6px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .card.contradicts {
    border-color: #ff6b6b;
  }

  .card.collapsed {
    padding: 6px 10px;
    opacity: 0.55;
  }

  .question {
    color: #8a8a86;
    font-size: 11px;
    line-height: 1.4;
    margin: 0;
  }

  .quick-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .quick-text {
    color: #e8e8e4;
    font-size: 13px;
    line-height: 1.5;
  }

  .chip {
    flex-shrink: 0;
    color: #6a6a66;
    font-size: 9px;
    letter-spacing: 0.03em;
    border: 1px solid #2a2a26;
    border-radius: 999px;
    padding: 1px 6px;
  }

  .deep-pending {
    color: #6a6a66;
    font-size: 11px;
    margin: 0;
  }

  .deep-agree {
    color: #8a8a86;
    font-size: 11px;
    margin: 0;
  }

  .deep-warning {
    color: #ff6b6b;
    font-size: 12px;
    line-height: 1.4;
    margin: 0;
  }

  .actions {
    display: flex;
    gap: 10px;
    margin-top: 2px;
  }

  .action-btn {
    background: none;
    border: 1px solid #2a2a26;
    color: #8a8a86;
    font-size: 10px;
    letter-spacing: 0.02em;
    padding: 3px 9px;
    border-radius: 999px;
    cursor: pointer;
  }

  .action-btn:hover:not(:disabled) {
    border-color: #e8e8e4;
    color: #e8e8e4;
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .collapsed-row {
    background: none;
    border: none;
    padding: 0;
    width: 100%;
    text-align: left;
    cursor: default;
  }

  .collapsed-question {
    display: block;
    color: #6a6a66;
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
