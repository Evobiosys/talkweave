<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — "ask the conversation" docked card (ask-the-conversation
  // handover, part 2). Same visual idiom as factcheck_card.svelte (dark
  // card, docked stack, dismiss action) rather than a second one — the
  // one real difference is structural: this card shows its RETRIEVED
  // MATCHES immediately (they were computed synchronously at creation,
  // see ask_reducer.ts's header comment), with the model's judgement
  // — same/contradicts/free-form answer — layered on underneath, once
  // (if ever) it arrives. A card with zero matches and no model call in
  // flight is still a complete, honest answer: "nothing like this was
  // said before."
  //
  // Progress: no persisted ETA store backs this route the way `.deep_
  // stats.json` backs factcheck's deep card (see server/lib/router.mjs's
  // `handle_ask` doc comment for why) — a plain count-up elapsed-seconds
  // ticker while `modelStatus === 'running'` is "real progress" enough
  // for a route that's always a single call, never factcheck's two-stage
  // reveal.

  import type { AskCardState, AskMatch } from './ask_reducer';
  import { format_ts } from './transcript_helpers';

  let {
    card,
    ondismiss,
    onjump
  }: {
    card: AskCardState;
    ondismiss: (id: string) => void;
    onjump: (match: AskMatch) => void;
  } = $props();

  let elapsedMs = $state(0);

  $effect(() => {
    if (card.modelStatus !== 'running') return;
    const startedAt = Date.now();
    elapsedMs = 0;
    const id = setInterval(() => {
      elapsedMs = Date.now() - startedAt;
    }, 250);
    return () => clearInterval(id);
  });

  const elapsedSeconds = $derived(Math.floor(elapsedMs / 1000));

  const modeLabel = $derived(
    card.mode === 'recall' ? 'did we talk about this before?' : card.mode === 'contradiction' ? 'was this contradicted elsewhere?' : 'ask'
  );
</script>

<div
  class="card"
  class:contradicts={card.mode === 'contradiction' && card.modelStatus === 'done' && card.contradicts === true}
>
  <p class="label">{modeLabel}</p>
  <p class="query">{card.query}</p>

  {#if card.matches.length === 0}
    <p class="empty-hint">nothing like this was found elsewhere in this conversation.</p>
  {:else}
    <ul class="matches">
      {#each card.matches as m (m.segmentId)}
        <li>
          <button type="button" class="match-row" onclick={() => onjump(m)}>
            <span class="match-text">{m.text}</span>
            <span class="match-meta">
              <span class="match-speaker">{m.speaker ?? 'unattributed'}</span>
              <span class="match-time">{format_ts(m.tStart)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if card.modelStatus === 'running'}
    <p class="model-pending">asking the local model — {elapsedSeconds}s…</p>
  {:else if card.modelStatus === 'unavailable'}
    <p class="model-unavailable">
      {card.matches.length === 0 ? 'no related passage to judge against.' : 'local model unreachable — showing retrieval results only.'}
    </p>
  {:else if card.modelStatus === 'done'}
    {#if card.mode === 'contradiction' && card.contradicts}
      <p class="model-warning">⚠ {card.modelText || 'the deeper look differs.'}</p>
    {:else if card.mode === 'recall' && card.sameTopic === false}
      <p class="model-note">the model thinks these are not actually the same topic: {card.modelText}</p>
    {:else if card.modelText}
      <p class="model-answer">{card.modelText}</p>
    {/if}
  {/if}

  <div class="actions">
    <button type="button" class="action-btn" onclick={() => ondismiss(card.id)}>dismiss</button>
  </div>
</div>

<style>
  .card {
    width: 320px;
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

  .label {
    color: #6a6a66;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin: 0;
  }

  .query {
    color: #8a8a86;
    font-size: 11px;
    line-height: 1.4;
    margin: 0;
  }

  .empty-hint {
    color: #6a6a66;
    font-size: 11px;
    margin: 0;
  }

  .matches {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 160px;
    overflow-y: auto;
  }

  .match-row {
    width: 100%;
    text-align: left;
    background: #111;
    border: 1px solid #222;
    border-radius: 4px;
    padding: 6px 8px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .match-row:hover {
    border-color: #e8e8e4;
  }

  .match-text {
    color: #d8d8d4;
    font-size: 11px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .match-meta {
    display: flex;
    gap: 8px;
  }

  .match-speaker,
  .match-time {
    color: #6a6a66;
    font-size: 9px;
    letter-spacing: 0.03em;
  }

  .model-pending,
  .model-unavailable {
    color: #6a6a66;
    font-size: 11px;
    margin: 0;
  }

  .model-note,
  .model-answer {
    color: #e8e8e4;
    font-size: 12px;
    line-height: 1.4;
    margin: 0;
  }

  .model-warning {
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

  .action-btn:hover {
    border-color: #e8e8e4;
    color: #e8e8e4;
  }
</style>
