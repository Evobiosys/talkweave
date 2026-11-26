<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — Task 7's bottom bar: session timeline, replacing
  // app.svelte's old `<p class="placeholder">audio bar</p>`.
  //
  // Two modes, decided once by app.svelte at session-ready time (from
  // `session.audioFile === null`, captured *before* the recorder's first
  // upload can flip it — see app.svelte's `handle_session_ready` comment;
  // reading `audioFile` reactively here instead would flip a live session
  // into "review" mid-recording the moment the first 60s upload lands):
  //
  //   - live: no audio to play yet — the bar is a growing meter of
  //     elapsed time (`liveT()`, polled every 250ms), "● rec" on the
  //     left, non-interactive (no click/drag-to-seek — there's no
  //     recording to seek into yet).
  //   - review: a `<audio>` element streams `GET /api/session/:id/audio`;
  //     the timeline is click/drag-seekable, shows a play/pause toggle
  //     and a current-time cursor.
  //
  // One formula drives both the progress fill and every tick mark
  // (flags/notes/fact-checks): `marker_percent(t, scale)` from
  // audio_helpers.ts, where `scale` is `liveT()` itself in live mode (so
  // the fill is always exactly 100% — "now" — and existing marks
  // compress leftward as elapsed time grows) or the resolved `<audio>`
  // duration in review mode. Same seam-consolidation instinct as
  // app.svelte's `current_t()` — one function, two scale inputs, rather
  // than a parallel "live percent" formula.
  //
  // Seek is bidirectional: this component's own click/drag calls
  // `onseek?.(t)` (app.svelte forwards to transcript-scroll +
  // `seekRequest` for symmetry); a seek that originates *elsewhere*
  // (transcript timestamp-gutter click, sidebar flag jump) arrives here
  // via the `seekRequest` prop (`{t, nonce}` — same "nonce must change on
  // every request, even a repeat" contract as transcript_view.svelte's
  // `ScrollRequest`) and is applied to `audioEl.currentTime` in an
  // `$effect`.
  //
  // Playback sync: `ontimeupdate` reports `currentTime` up to app.svelte
  // via `onplaybacktime`, which forwards it to `transcript_view.svelte`'s
  // `currentPlaybackT` prop for the faint current-segment underline +
  // follow-if-pinned scroll (task-7-brief.md).
  //
  // Color discipline (global-constraints.md: amber = flag semantic only,
  // red = contradiction warning only): flag ticks are filled amber, note
  // ticks are hollow off-white/gray (no color claim), fact-check markers
  // are a gray/off-white diamond that only turns red when
  // `deep.contradicts === true` — never a fourth hue for "no mic" or
  // anything else.

  import type { Session } from '../../../shared/model';
  import { format_hms } from './session_clock';
  import { format_ts } from './transcript_helpers';
  import { data_extent_seconds, marker_percent, resolve_duration } from './audio_helpers';

  let {
    session,
    sessionId,
    mode,
    liveT,
    noMic = false,
    paused = false,
    isLiveSession = false,
    onseek,
    onplaybacktime,
    onpausetoggle,
    seekRequest = null
  }: {
    session: Session;
    sessionId: string;
    mode: 'live' | 'review';
    /** Live-mode elapsed-seconds source — app.svelte's `current_t()`, the
     *  same seam flag/note creation uses, so the bar's growth always
     *  agrees with where flags land on it. Required in live mode; unused
     *  in review mode (the `<audio>` element is the clock there). */
    liveT?: () => number;
    noMic?: boolean;
    /** v0.3 train-fixes Part B: whether the session is currently paused
     *  (app.svelte's `paused` state, mirroring `audioRecorder.paused`).
     *  Live mode only — review mode has no recorder to pause. */
    paused?: boolean;
    /** Review-round fix 1: `mode === 'live'` alone is NOT "a real,
     *  freshly-started live/recording session" — a demo (ReplayEngine)
     *  session ALSO reports `mode === 'live'` here, because app.svelte's
     *  `audioMode` is derived from `session.audioFile === null`
     *  (session_ready-time snapshot) and a demo session never persists
     *  audio either (see app.svelte's `audioMode` doc comment). Gates the
     *  pause/resume control specifically — app.svelte's `isLiveSession`
     *  (`= plan.startRecorder` from `session_mode_plan`, same signal
     *  transcript_view.svelte's Part C status line already uses) is the
     *  one prop that actually distinguishes "a recorder genuinely
     *  exists" from "this session merely reports audioFile === null."
     *  Without this, the pause button rendered — inert, since
     *  `handle_pause_toggle` no-ops with no `audioRecorder` — for demo
     *  and resumed sessions, which reads as broken UI rather than
     *  correctly absent. */
    isLiveSession?: boolean;
    onseek?: (t: number) => void;
    onplaybacktime?: (t: number) => void;
    /** Toggles pause/resume — app.svelte owns the actual
     *  `audioRecorder.pause()/resume()` + `store.start_pause/end_pause`
     *  calls; this component only asks for the toggle. Live mode only. */
    onpausetoggle?: () => void;
    seekRequest?: { t: number; nonce: number } | null;
  } = $props();

  const LIVE_POLL_MS = 250;

  let audioEl: HTMLAudioElement | undefined = $state();
  let timelineEl: HTMLDivElement | undefined = $state();
  let rawDuration = $state(0);
  let currentTime = $state(0);
  let playing = $state(false);
  let liveElapsed = $state(0);
  let dragging = $state(false);
  // True only for the duration of `unlock_duration`'s probe seek — see
  // that function's doc comment. Suppresses `handle_timeupdate`'s
  // `currentTime`/`onplaybacktime` side effects for the split-second the
  // probe is in flight, so neither the cursor nor the transcript's
  // playback-sync underline visibly jumps to the far end and back.
  let probingDuration = $state(false);

  // Live-mode polling: `liveT` is a pure snapshot function (same
  // convention as session_header.svelte's own `session_elapsed_seconds`
  // polling) — something has to re-read it on an interval for the bar to
  // visibly move.
  $effect(() => {
    if (mode !== 'live') return;
    liveElapsed = liveT ? liveT() : 0;
    const id = setInterval(() => {
      liveElapsed = liveT ? liveT() : 0;
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  });

  // External seek (transcript gutter / sidebar jump) -> move the
  // `<audio>` element. A no-op in live mode (no `audioEl` exists yet).
  $effect(() => {
    const req = seekRequest;
    if (!req || !audioEl) return;
    audioEl.currentTime = req.t;
  });

  const fallbackDuration = $derived(data_extent_seconds(session));
  const duration = $derived(mode === 'review' ? resolve_duration(rawDuration, fallbackDuration) : 0);
  const scale = $derived(mode === 'live' ? liveElapsed : duration);
  const displayT = $derived(mode === 'live' ? liveElapsed : currentTime);
  const fillPercent = $derived(marker_percent(displayT, scale));

  const flagMarkers = $derived(
    session.flags.map((f) => ({ id: f.id, t: f.t, pct: marker_percent(f.t, scale) }))
  );
  const noteMarkers = $derived(
    session.notes.map((n) => ({ id: n.id, t: n.t, pct: marker_percent(n.t, scale) }))
  );
  const factCheckMarkers = $derived(
    session.factChecks.map((fc) => ({
      id: fc.id,
      t: fc.t,
      pct: marker_percent(fc.t, scale),
      contradicts: fc.deep?.contradicts === true
    }))
  );

  function handle_loaded_metadata(): void {
    if (!audioEl) return;
    rawDuration = audioEl.duration;
    if (!Number.isFinite(rawDuration)) unlock_duration();
  }

  /**
   * A recorded webm (no `Cues`/`SeekHead` duration in its container
   * header, since MediaRecorder streams it out incrementally) makes
   * Chromium report `audio.duration` as `Infinity` — confirmed via this
   * task's own headless verification: without this, a mid-timeline click
   * on a real ~70s recording only ever seeks within the first ~1.5s
   * (`data_extent_seconds`'s fallback, driven by how little of the
   * session had been transcribed/flagged at review time — accurate for
   * *that* data, but a bad stand-in for the *audio's* actual length).
   * The standard browser workaround: seeking far past the end forces the
   * demuxer to scan to the real end of the stream and resolve a finite
   * `duration`, which then arrives on the next `timeupdate` — at which
   * point the probe seek is undone (back to wherever playback actually
   * was) so this is invisible to the user. `resolve_duration`'s
   * `data_extent_seconds` fallback still covers the brief window before
   * this resolves (and the pathological case of a browser that never
   * resolves it at all).
   *
   * Listens for `durationchange`, not `timeupdate`: the seek toward the
   * end can fire an intermediate `timeupdate` (or several) before
   * `duration` itself has actually flipped from `Infinity` to a real
   * number — resolving on the wrong event risks undoing the probe seek
   * mid-flight, before the demuxer has actually settled on a real
   * duration, which (confirmed while building this against a real ~70s
   * fake-mic recording with no server-side Range support to fall back
   * on) can leave the seek half-applied. `durationchange` fires
   * precisely when `duration` itself updates, so waiting for it (looping
   * past any earlier no-op firings where `duration` is still infinite)
   * is the correct signal, not an approximation of one.
   *
   * Bounded (fix round 1, task-7-report.md, Finding 2): this server has
   * no Range support (Task 3's explicit scope), which is exactly the
   * mechanism Chromium's duration resolution normally leans on — so
   * `durationchange` reporting a finite value here is not guaranteed.
   * Without a timeout, a browser/file combination that never fires it
   * would leave `probingDuration` stuck `true` forever, which
   * permanently stops `handle_timeupdate` from updating `currentTime`/
   * `onplaybacktime` — freezing the cursor and the transcript's
   * playback-sync underline for the rest of the session. `DURATION_
   * UNLOCK_TIMEOUT_MS` guarantees this always resolves one way or the
   * other: either a real duration lands, or the probe gives up and
   * playback-sync resumes with `resolve_duration`'s `data_extent_seconds`
   * fallback still driving marker math.
   */
  const DURATION_UNLOCK_TIMEOUT_MS = 3000;

  function unlock_duration(): void {
    if (!audioEl) return;
    const el = audioEl;
    const savedTime = el.currentTime;
    probingDuration = true;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('durationchange', on_duration_change);
      clearTimeout(timeoutId);
      el.currentTime = savedTime;
      probingDuration = false;
    };
    const on_duration_change = () => {
      if (!Number.isFinite(el.duration)) return; // still resolving — keep waiting
      rawDuration = el.duration;
      finish();
    };
    const timeoutId = setTimeout(finish, DURATION_UNLOCK_TIMEOUT_MS);

    el.addEventListener('durationchange', on_duration_change);
    el.currentTime = 1e9;
  }

  function handle_timeupdate(): void {
    if (!audioEl || probingDuration) return;
    currentTime = audioEl.currentTime;
    if (Number.isFinite(audioEl.duration)) rawDuration = audioEl.duration;
    onplaybacktime?.(currentTime);
  }

  function toggle_play(): void {
    if (!audioEl) return;
    if (audioEl.paused) void audioEl.play();
    else audioEl.pause();
  }

  function pct_from_pointer(e: PointerEvent): number {
    if (!timelineEl) return 0;
    const rect = timelineEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    return (x / rect.width) * 100;
  }

  function seek_to_pct(pct: number): void {
    if (duration <= 0) return;
    const t = (pct / 100) * duration;
    if (audioEl) audioEl.currentTime = t;
    onseek?.(t);
  }

  function handle_pointerdown(e: PointerEvent): void {
    if (mode !== 'review') return;
    dragging = true;
    timelineEl?.setPointerCapture(e.pointerId);
    seek_to_pct(pct_from_pointer(e));
  }

  function handle_pointermove(e: PointerEvent): void {
    if (!dragging) return;
    seek_to_pct(pct_from_pointer(e));
  }

  function handle_pointerup(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    timelineEl?.releasePointerCapture(e.pointerId);
  }
</script>

<div class="audio-bar">
  {#if mode === 'live'}
    <span class="rec-indicator" class:noMic class:paused>{noMic ? '○ no mic' : '● rec'}</span>
  {:else}
    <button class="play-btn" type="button" onclick={toggle_play} aria-label={playing ? 'pause' : 'play'}>
      {playing ? '❚❚' : '►'}
    </button>
  {/if}

  {#if mode === 'live' && isLiveSession}
    <button
      class="pause-toggle"
      type="button"
      onclick={onpausetoggle}
      aria-label={paused ? 'resume' : 'pause'}
    >
      {paused ? '‖ paused' : '⏸ pause'}
    </button>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- `role`/`tabindex`
       are genuinely conditional (review mode only): the compiler's static
       a11y check can't see that they always agree (both set together, both
       `undefined` together), so it falls back to treating this as a bare,
       always-non-interactive `<div>`. Live mode legitimately has nothing
       to seek into yet — no recording exists — so the element really is
       inert there, which is exactly what `tabindex={undefined}` +
       `role={undefined}` produce at runtime. -->
  <div
    class="timeline"
    class:seekable={mode === 'review'}
    bind:this={timelineEl}
    role={mode === 'review' ? 'slider' : undefined}
    aria-label={mode === 'review' ? 'seek' : undefined}
    aria-valuemin={mode === 'review' ? 0 : undefined}
    aria-valuemax={mode === 'review' ? duration : undefined}
    aria-valuenow={mode === 'review' ? currentTime : undefined}
    tabindex={mode === 'review' ? 0 : undefined}
    onpointerdown={handle_pointerdown}
    onpointermove={handle_pointermove}
    onpointerup={handle_pointerup}
    onpointercancel={handle_pointerup}
  >
    <div class="track"></div>
    <div class="fill" style:width="{fillPercent}%"></div>

    {#each factCheckMarkers as m (m.id)}
      <div
        class="tick tick-factcheck"
        class:contradicts={m.contradicts}
        style:left="{m.pct}%"
        title={`fact-check @ ${format_ts(m.t)}`}
      ></div>
    {/each}
    {#each noteMarkers as m (m.id)}
      <div class="tick tick-note" style:left="{m.pct}%" title={`note @ ${format_ts(m.t)}`}></div>
    {/each}
    {#each flagMarkers as m (m.id)}
      <div class="tick tick-flag" style:left="{m.pct}%" title={`flag @ ${format_ts(m.t)}`}></div>
    {/each}

    {#if mode === 'review'}
      <div class="cursor" style:left="{fillPercent}%"></div>
    {/if}
  </div>

  <span class="time-label">{format_hms(displayT)}</span>

  {#if mode === 'live' && noMic}
    <span class="chip">performance clock — no audio recorded</span>
  {/if}
</div>

{#if mode === 'review'}
  <audio
    bind:this={audioEl}
    src={`/api/session/${sessionId}/audio`}
    preload="metadata"
    onloadedmetadata={handle_loaded_metadata}
    ontimeupdate={handle_timeupdate}
    onplay={() => (playing = true)}
    onpause={() => (playing = false)}
  ></audio>
{/if}

<style>
  .audio-bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    height: 100%;
    padding: 0 20px;
  }

  .rec-indicator {
    flex: 0 0 auto;
    color: #ffb84d;
    font-size: 12px;
    letter-spacing: 0.03em;
    animation: pulse 1.4s ease-in-out infinite;
  }

  .rec-indicator.noMic {
    color: #6a6a66;
    animation: none;
  }

  .rec-indicator.paused {
    color: #6a6a66;
    animation: none;
  }

  /* v0.3 train-fixes Part B — centered in the bar regardless of the other
     (flex-laid-out) children, per the plan's "small pause/resume button
     centered in the bottom audio bar." */
  .pause-toggle {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    background: none;
    border: 1px solid #3a3a36;
    color: #6a6a66;
    font-size: 11px;
    letter-spacing: 0.02em;
    border-radius: 999px;
    padding: 3px 12px;
    cursor: pointer;
    z-index: 1;
  }

  .pause-toggle:hover {
    border-color: #ffb84d;
    color: #ffb84d;
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

  .play-btn {
    flex: 0 0 auto;
    background: none;
    border: 1px solid #3a3a36;
    color: #e8e8e4;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .play-btn:hover {
    border-color: #ffb84d;
    color: #ffb84d;
  }

  .timeline {
    position: relative;
    flex: 1 1 auto;
    height: 22px;
    display: flex;
    align-items: center;
  }

  .timeline.seekable {
    cursor: pointer;
  }

  .track {
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    background: #1e1e1a;
    border-radius: 2px;
  }

  .fill {
    position: absolute;
    left: 0;
    height: 3px;
    background: #3a3a36;
    border-radius: 2px;
    pointer-events: none;
  }

  .tick {
    position: absolute;
    top: 3px;
    width: 2px;
    height: 16px;
    transform: translateX(-1px);
    pointer-events: none;
  }

  .tick-flag {
    background: #ffb84d;
  }

  .tick-note {
    background: transparent;
    border: 1px solid #6a6a66;
    width: 4px;
    transform: translateX(-2px);
  }

  .tick-factcheck {
    top: 6px;
    width: 7px;
    height: 7px;
    background: #8a8a86;
    border: none;
    transform: translateX(-3.5px) rotate(45deg);
  }

  .tick-factcheck.contradicts {
    background: #ff6b6b;
  }

  .cursor {
    position: absolute;
    top: -3px;
    width: 1px;
    height: 28px;
    background: #e8e8e4;
    pointer-events: none;
  }

  .time-label {
    flex: 0 0 auto;
    color: #6a6a66;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .chip {
    flex: 0 0 auto;
    color: #6a6a66;
    font-size: 11px;
    border: 1px solid #2a2a26;
    border-radius: 999px;
    padding: 2px 10px;
  }
</style>
