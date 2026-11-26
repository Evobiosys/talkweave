<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — boot screen. Centered wordmark, two session-start actions
  // (Task 8, replacing Task 1-7's single "begin conversation" button — a
  // third near-synonym button was judged worse UI than splitting the one
  // action into its two real modes), and a list of past sessions
  // (GET /api/sessions) that load the same way on click. Black/white/
  // minimal per global-constraints.md; no color beyond the shared
  // muted-gray/off-white palette.
  //
  // "demo conversation": POSTs a new session, then tells app.svelte to
  // start it in `'demo'` mode — a forced ReplayEngine over
  // fixtures/demo_conversation.ts, no mic/audio recording at all (a
  // scripted demo has no real audio to record).
  // "live session": POSTs a new session, `'live'` mode — Task 7's audio
  // recording starts as before, plus whichever engine Task 6's settings
  // currently select (replay or the v0.1 no-op mic placeholder).
  // Clicking a past session in the list below is `'resume'` mode: never
  // starts a fresh engine (a demo session's `audioFile` stays null
  // forever, since demo replay never records audio — restarting
  // ReplayEngine on reopen would replay the whole fixture again on top of
  // what's already there), but a genuinely interrupted live/mic session
  // still gets its recorder back exactly as Task 7 shipped it (see
  // app.svelte's `handle_session_ready` for the full gating logic).

  import type { Session } from '../../../shared/model';
  import { parse_session } from '../../../shared/session_md';
  import type { SessionStartMode } from './session_start_mode';

  let { onready }: { onready: (session: Session, mode: SessionStartMode) => void } = $props();

  interface SessionListing {
    id: string;
    title: string;
  }

  let sessions = $state<SessionListing[]>([]);
  let loadingList = $state(true);
  let startingMode = $state<'demo' | 'live' | null>(null);
  let loadingId = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);

  async function load_sessions_list(): Promise<void> {
    loadingList = true;
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      sessions = res.ok && data.ok && Array.isArray(data.sessions) ? data.sessions : [];
    } catch {
      sessions = [];
    } finally {
      loadingList = false;
    }
  }

  async function open_session(id: string, mode: SessionStartMode): Promise<void> {
    errorMsg = null;
    loadingId = id;
    try {
      const res = await fetch(`/api/session/${id}`);
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const text = await res.text();
      onready(parse_session(text), mode);
    } catch {
      errorMsg = `Could not load session ${id}.`;
    } finally {
      loadingId = null;
    }
  }

  async function start_new_session(mode: 'demo' | 'live'): Promise<void> {
    errorMsg = null;
    startingMode = mode;
    try {
      const res = await fetch('/api/session', { method: 'POST' });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      const data = await res.json();
      if (!data.ok || typeof data.id !== 'string') throw new Error('create failed: malformed response');
      await open_session(data.id, mode);
    } catch {
      errorMsg = 'Could not start a new conversation.';
    } finally {
      startingMode = null;
    }
  }

  load_sessions_list();
</script>

<div class="start">
  <div class="hero">
    <h1 class="wordmark">talkweave</h1>
    <div class="start-actions">
      <button
        class="begin"
        type="button"
        onclick={() => start_new_session('demo')}
        disabled={startingMode !== null}
      >
        {startingMode === 'demo' ? 'starting…' : 'demo conversation'}
      </button>
      <button
        class="begin"
        type="button"
        onclick={() => start_new_session('live')}
        disabled={startingMode !== null}
      >
        {startingMode === 'live' ? 'starting…' : 'live session'}
      </button>
    </div>
    {#if errorMsg}
      <p class="error">{errorMsg}</p>
    {/if}
  </div>

  <div class="past">
    {#if loadingList}
      <p class="hint">loading sessions…</p>
    {:else if sessions.length > 0}
      <ul>
        {#each sessions as s (s.id)}
          <li>
            <button
              class="session-item"
              type="button"
              onclick={() => open_session(s.id, 'resume')}
              disabled={loadingId !== null}
            >
              <span class="session-title">{s.title || s.id}</span>
              <span class="session-id">{s.id}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .start {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 48px;
    height: 100vh;
    width: 100vw;
    background: #000;
    color: #e8e8e4;
    padding: 24px;
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }

  .wordmark {
    font-size: 28px;
    font-weight: 400;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    color: #e8e8e4;
  }

  .start-actions {
    display: flex;
    gap: 12px;
  }

  .begin {
    background: none;
    border: 1px solid #3a3a36;
    color: #e8e8e4;
    padding: 10px 24px;
    font-size: 14px;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition:
      border-color 120ms ease-out,
      background 120ms ease-out;
  }

  .begin:hover:not(:disabled) {
    border-color: #ffb84d;
    background: rgba(255, 184, 77, 0.08);
  }

  .begin:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    color: #ff6b6b;
    font-size: 13px;
  }

  .past {
    width: 100%;
    max-width: 420px;
    min-height: 20px;
  }

  .hint {
    text-align: center;
    color: #6a6a66;
    font-size: 13px;
  }

  ul {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 40vh;
    overflow-y: auto;
  }

  .session-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    background: none;
    border: none;
    border-bottom: 1px solid #1a1a1a;
    color: #e8e8e4;
    padding: 10px 4px;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .session-item:hover:not(:disabled) {
    color: #ffb84d;
  }

  .session-item:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .session-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-id {
    flex-shrink: 0;
    color: #6a6a66;
    font-size: 11px;
  }
</style>
