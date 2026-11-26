<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — Task 9's collapsed summary dividers ("— summary 00:15 —",
  // click expands). Kept as a sibling of transcript_view.svelte rather than
  // folded into it (task-9-brief.md's context notes: "keep transcript_view
  // lean") — a bounded, independently-scrolling strip stacked above the
  // transcript within the same 760px content column, one entry per
  // Summary, chronological by `tTo`. Store-agnostic (same convention as
  // every other component here): plain `summaries` prop, no SessionStore
  // import.

  import type { Summary } from '../../../shared/model';
  import { format_ts } from './transcript_helpers';

  let { summaries }: { summaries: Summary[] } = $props();

  const sorted = $derived([...summaries].sort((a, b) => a.tTo - b.tTo));

  let expandedIds = $state<Set<string>>(new Set());

  function toggle(id: string): void {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedIds = next;
  }
</script>

{#if sorted.length > 0}
  <div class="summary-list">
    {#each sorted as s (s.id)}
      <div class="summary-entry">
        <button
          type="button"
          class="summary-divider"
          onclick={() => toggle(s.id)}
          aria-expanded={expandedIds.has(s.id)}
        >
          <span class="line"></span>
          <span class="label">summary {format_ts(s.tTo)}{s.trigger === 'manual' ? ' · manual' : ''}</span>
          <span class="line"></span>
        </button>
        {#if expandedIds.has(s.id)}
          <div class="summary-body">{s.text}</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .summary-list {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 140px;
    overflow-y: auto;
    padding: 0 16px 8px;
  }

  .summary-entry {
    display: flex;
    flex-direction: column;
  }

  .summary-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    padding: 4px 0;
    cursor: pointer;
    width: 100%;
  }

  .summary-divider .line {
    flex: 1 1 auto;
    height: 1px;
    background: #1e1e1a;
  }

  .summary-divider:hover .line {
    background: rgba(255, 184, 77, 0.4);
  }

  .summary-divider .label {
    flex: 0 0 auto;
    color: #6a6a66;
    font-size: 10px;
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
  }

  .summary-divider:hover .label {
    color: #ffb84d;
  }

  .summary-body {
    color: #b8b8b4;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-line;
    padding: 2px 4px 10px;
  }
</style>
