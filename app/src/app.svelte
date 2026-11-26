<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave: application shell.
  // Three-column grid (side panels fixed 280px, center flexible max-width 760px,
  // centered), full-viewport black background. Absolutely-positioned top bar
  // (settings drawer placeholder) hidden by default, revealed on near-top hover
  // or the "," key, and held open while the pointer is anywhere over it (Task
  // 14 — see top_bar_visibility.ts for the show/hide decision itself). Fixed-
  // height bottom bar: Task 7's `audio_bar.svelte` (session timeline — live
  // recording meter or review-mode playback/seek).

  import type { Flag, Session, Speaker } from '../../shared/model';
  import type { TranscriptionEngine } from '../../shared/engine';
  import { fetch_claim, fetch_summary } from './lib/ai_client';
  import {
    create_in_flight_guard,
    ollama_offline_next_state,
    should_extract_claim_for_flag,
    window_claim_context
  } from './lib/ai_pipeline';
  import AudioBar from './lib/audio_bar.svelte';
  import { create_audio_recorder, type AudioRecorderController } from './lib/audio_recorder';
  import { data_extent_seconds, resolve_current_t, resolve_review_t, segment_at } from './lib/audio_helpers';
  import { create_engine_bridge } from './lib/engine_bridge';
  import { bind_keymap, is_typing_target, listener_for } from './lib/keymap';
  import { format_lag_label } from './lib/lag_helpers';
  import { create_mic_engine, type MicEngine } from './lib/mic_engine';
  import { mic_status_text } from './lib/mic_status';
  import { create_replay_engine } from './lib/replay_engine';
  import { session_elapsed_seconds } from './lib/session_clock';
  import {
    engine_indicator_label,
    fetch_whisper_status,
    live_status_text,
    mic_ready,
    type WhisperStatus
  } from './lib/whisper_status';
  import SessionHeader from './lib/session_header.svelte';
  import { session_mode_plan } from './lib/session_mode_plan';
  import type { SessionStartMode } from './lib/session_start_mode';
  import { SessionStore } from './lib/session_store.svelte';
  import { SettingsStore } from './lib/settings_store.svelte';
  import SettingsDrawer from './lib/settings_drawer.svelte';
  import SidePanel from './lib/side_panel.svelte';
  import StartScreen from './lib/start_screen.svelte';
  import { should_fire_interval_summary } from './lib/summary_scheduler';
  import SummaryDividers from './lib/summary_dividers.svelte';
  import { init_top_bar_state, top_bar_reducer, top_bar_visible, type TopBarEvent } from './lib/top_bar_visibility';
  import TranscriptView from './lib/transcript_view.svelte';
  import type { ResolvedSelection } from './lib/transcript_view.svelte';
  import type { DblclickFlagSpan, ScrollRequest } from './lib/transcript_helpers';
  import { latest_flag, excerpt_for } from './lib/flag_helpers';
  import { normalize_selected_text } from './lib/selection_helpers';
  import { start_factcheck_stream, type FactCheckStreamHandle } from './lib/factcheck_client';
  import {
    factcheck_card_reducer,
    init_factcheck_card,
    type FactCheckCardAction,
    type FactCheckCardState
  } from './lib/factcheck_reducer';
  import { attribution_for, expanded_card_ids } from './lib/factcheck_helpers';
  import FactCheckCard from './lib/factcheck_card.svelte';
  import FactCheckPrompt from './lib/factcheck_prompt.svelte';
  import { find_related_segments } from './lib/retrieval';
  import {
    ask_card_reducer,
    init_ask_card,
    type AskCardAction,
    type AskCardState,
    type AskMatch,
    type AskMode
  } from './lib/ask_reducer';
  import { start_ask, type AskCandidate, type AskHandle } from './lib/ask_client';
  import AskCard from './lib/ask_card.svelte';
  import AskPrompt from './lib/ask_prompt.svelte';

  // Task 3 scope: the store lives here, local to the shell, until a later
  // task needs it shared across components (context/singleton) — no
  // reason to build that plumbing before anything consumes it (YAGNI).
  let store = $state<SessionStore | null>(null);

  // Task 6: settings are independent of any one session (localStorage-
  // persisted, not part of Session/session_md.ts — see
  // settings_store_core.ts's header comment), so this is constructed once,
  // unconditionally, rather than alongside `store` in
  // `handle_session_ready` below.
  const settingsStore = new SettingsStore();

  // v0.2 live transcription: fetched once at shell mount (same "the more
  // conservative state until the fetch settles" convention as
  // settings_drawer.svelte's own independent fetch of the same endpoint —
  // this is a SEPARATE call, not shared state, since this one feeds
  // `session_mode_plan`'s gating decision at session-start time rather
  // than a settings-drawer label; a small duplicated fetch is a fair
  // trade against threading a prop through SettingsDrawer for a value it
  // doesn't otherwise need). `micReady` (whisper_status.ts) is the one
  // condition `session_mode_plan` actually gates `startMic` on: BOTH the
  // binary and the model file present, not just the binary.
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
  // qwen-asr-engine handover, Task B item 2: a small, always-on header
  // chip naming whichever engine the server picked, shown regardless of
  // session mode (demo/live/review) since it reflects the app's own ASR
  // configuration, not this particular session, mirroring `whisperStatus`
  // itself being fetched once at shell mount rather than per-session.
  let engineIndicator = $derived(engine_indicator_label(whisperStatus));
  // Task B item 1: the live-session empty-transcript status line
  // (transcript_view.svelte), replacing v0.2's static "arrives in v0.2"
  // claim with an honest one driven by the same availability payload.
  let liveStatusText = $derived(live_status_text(whisperStatus));

  // Task 7: the ONE seam for "current session time." Every t-stamping
  // call site in this file (keymap dispatch, dblclick-flag creation,
  // SidePanel's note-creation `now` prop) now reads through this single
  // function instead of each calling `session_elapsed_seconds` directly
  // (Task 5/6's original wiring — see git history). Live session with a
  // working mic: `audioRecorder.now()`, the recorder's own elapsed-since-
  // MediaRecorder-start clock, so flag/note `t` values land on the exact
  // same timeline as the audio file's own t=0 (task-7-brief.md). No
  // recorder for this session at all (a review session, replay-engine
  // session, or anything else that never called `create_audio_recorder`)
  // falls back to Task 5's original wall-clock-since-`startedAt` source —
  // `audioRecorder` itself already encodes the "mic denied/unavailable"
  // fallback internally (see that module's header comment).
  //
  // Fix round 1 (task-7-report.md, Finding 1): a recorder *existing* is
  // not the same as its timebase being *established*. `create_audio_
  // recorder()` returns synchronously; `start()`'s getUserMedia/
  // MediaRecorder negotiation is async and a permission prompt can take
  // seconds. Before that settles, `audioRecorder.now()` would return a
  // bare, misleading 0 — silently mislabeling any flag/note created in
  // that window as t=0. `resolve_current_t` (audio_helpers.ts, unit
  // tested) makes this explicit: only use the recorder clock once
  // `audioRecorder.ready` is true; otherwise fall through to
  // `session_elapsed_seconds`, exactly like a session with no recorder at
  // all.
  //
  // Deliberately NOT touching session_header.svelte's own ticking
  // "hh:mm:ss" clock (still `session_elapsed_seconds(startedAt)`,
  // unchanged) — the brief's refactor scope names `app.svelte`'s
  // `current_t()` and `session_clock.ts` specifically, and the header
  // clock is a *display*, not a t-stamping call site, so leaving it as
  // Task 6 shipped it is the minimal-refactor reading. `audio_bar.svelte`
  // is the one place that shows a live numeric elapsed time next to the
  // header's — it's fed from this same `current_t` seam (its `liveT`
  // prop below), so the two will agree closely; the header's own
  // interval-driven clock can drift from both by up to ~1s (its own
  // polling cadence) plus, briefly at session start, however long the
  // mic-permission prompt took to resolve. Judged an acceptable, narrow
  // divergence rather than reason to touch a component outside this
  // task's stated scope.
  // Task 8: a replay engine drives its own fixture timeline (seconds
  // since ITS start, scaled by replay speed — see replay_engine.ts's
  // `now()` doc comment), which has nothing to do with wall-clock elapsed
  // session time. At 8x speed the engine can be 180 fixture-seconds in
  // after only ~22 real seconds; without this branch, a flag created
  // mid-demo would fall through to `session_elapsed_seconds` and be
  // stamped ~22, while the segment it's flagging says tStart ~180 — a
  // real, silent mismatch (task-8-brief.md's Context section asked this
  // to be flagged if seen; see task-8-report.md). Checked first, ahead of
  // the audioRecorder branch: a replay-driven session never has a
  // recorder at all (see `handle_session_ready`'s 'demo' branch below).
  //
  // Final review fix, Important 1: a `'resume'` session never gets a
  // recorder (`session_mode_plan`'s `startRecorder` is false for
  // `'resume'`) or a replay clock (`replayClock` false too) — by this
  // point `replayNow` has already been checked and failed, so `!
  // audioRecorder` here is exactly the `'resume'`/review case (including
  // an interrupted live session resumed with `audioFile` still null: it
  // never re-arms a recorder either, per `session_mode_plan`'s header
  // comment). Route it through `resolve_review_t` (audio_helpers.ts,
  // unit-tested) instead of falling through to `session_elapsed_seconds`
  // (wall-clock since the session was originally created) — see that
  // function's doc comment for the multi-day-old-session bug this fixes.
  function current_t(): number {
    if (!store) return 0;
    if (replayNow) return replayNow();
    if (!audioRecorder) return resolve_review_t(playbackT, data_extent_seconds(store.session));
    const fallback = session_elapsed_seconds(store.session.startedAt);
    return resolve_current_t(audioRecorder.ready, audioRecorder.now(), fallback);
  }

  let audioRecorder = $state<AudioRecorderController | null>(null);
  let noMic = $state(false);
  // v0.3 train-fixes Part B: mirrors `audioRecorder.paused` for the UI
  // (audio_bar.svelte's centered toggle + rec-indicator dimming) — not
  // read directly off the recorder on every render because it's a plain
  // getter on a non-reactive closure, not a `$state` field; this is
  // flipped explicitly by `handle_pause_toggle` below, the only place
  // that calls `audioRecorder.pause()/resume()`.
  let paused = $state(false);
  // The `performance.now()` instant the most recent `pause()` press
  // happened, used only to compute the REAL wall-clock duration of the
  // pause for `store.end_pause` at resume time — see shared/model.ts's
  // `Pause` doc comment for why that duration can't be recovered from
  // `current_t()`/`audioRecorder.now()` alone (both freeze during a
  // pause by design). Not `$state`: nothing renders off this value.
  let pauseStartedAtMs: number | null = null;

  /**
   * Toggles pause/resume for a live session's recorder + session clock
   * (audio_bar.svelte's centered button). No-op with no recorder (review/
   * demo sessions never render this button at all, but the guard stays
   * defensive rather than assuming the caller never fires it).
   */
  function handle_pause_toggle(): void {
    if (!audioRecorder || !store) return;
    if (paused) {
      audioRecorder.resume();
      const durationS = pauseStartedAtMs !== null ? (performance.now() - pauseStartedAtMs) / 1000 : 0;
      const open = store.session.pauses.find((p) => p.tEnd === null);
      if (open) store.end_pause(open.tStart + durationS);
      pauseStartedAtMs = null;
      paused = false;
    } else {
      const t = current_t();
      audioRecorder.pause();
      pauseStartedAtMs = performance.now();
      store.start_pause(t);
      paused = true;
    }
  }

  // Task 8: the live engine (ReplayEngine or the mic no-op placeholder)
  // driving this session's transcript, if any — see `handle_session_ready`
  // for exactly which `SessionStartMode`s start one. `replayNow` is set
  // alongside `engine` only when it's specifically a ReplayEngine, purely
  // so `current_t()` above can read its fixture-timeline position without
  // widening `TranscriptionEngine` itself with a `now()` no real streaming
  // engine could implement (see shared/engine.ts's header comment).
  let engine = $state<TranscriptionEngine | null>(null);
  let replayNow = $state<(() => number) | null>(null);
  // v0.2: set alongside `engine` only when it's specifically a MicEngine —
  // same "extra typed accessor next to the plain interface" pattern as
  // `replayNow` above (shared/engine.ts's `TranscriptionEngine` itself
  // stays free of anything a real streaming engine couldn't implement).
  // The keymap's `set_speaker` dispatch below calls this so a manual
  // ArrowLeft/ArrowRight switch becomes a turn boundary for the mic
  // engine too — see mic_engine.ts's header comment for why that can't
  // just be a live `store.currentSpeaker` read from inside the engine.
  let micNotifySpeaker = $state<((speaker: Speaker | null) => void) | null>(null);
  // v0.2 step 6 graceful degradation: fires at most once per live mic
  // session, the first time `mic_engine.ts` reports whisper unavailable
  // (POST /api/mic/start failed) or the SSE connection dropped mid-
  // session — same visual convention as the existing "local AI offline"
  // chip below.
  let whisperOffline = $state(false);
  // qwen-asr-engine handover, Task B item 3: distinct from `whisperOffline`
  // above (that one is a hard, one-shot failure: the connection/POST
  // itself failed). This is a soft, recoverable signal from
  // `mic_engine.ts`'s `on_stall_change`: the SSE connection is still open
  // but no event of any kind has arrived for a while, meaning the
  // server-side tick loop has gone quiet (see that option's doc comment
  // for exactly what this can and can't distinguish from real silence).
  // Reset per-session below alongside `whisperOffline`; can flip back to
  // `false` mid-session if the pipe recovers, unlike `whisperOffline`.
  let asrStalled = $state(false);
  // live-subtitles handover, item 4: the raw millisecond reading from
  // `mic_engine.ts`'s `on_lag_change`, `null` until the mic engine's first
  // SSE event of THIS session (reset alongside `whisperOffline`/
  // `asrStalled` below). `lagLabel` (derived further down, near the other
  // `*_status_text`-style derivations) is what actually renders — this
  // stays the raw number so that derivation is the one place the
  // "hide below a small threshold" decision lives.
  let micLagMs = $state<number | null>(null);
  // live-subtitles handover, item 4: quiet lag chip — `format_lag_label`
  // returns `null` for a negligible reading (nothing worth disclosing) or
  // before the mic engine's first event, in which case the chip simply
  // doesn't render (see the `{#if lagLabel}` further down).
  let lagLabel = $derived(micLagMs === null ? null : format_lag_label(micLagMs));
  // Live-transcription-visibility fix: true only while a REAL `MicEngine`
  // is running THIS session (set in the `plan.startMic` branch below,
  // reset to false alongside `whisperOffline`/`asrStalled` per-session) —
  // see transcript_view.svelte's `micSessionActive` prop doc comment for
  // exactly which status line this gates. `micAudioStarted`/
  // `micPendingAudio`/`micLastDecodeMs` are the three real signals
  // `mic_status_text` (mic_status.ts) turns into that line's wording;
  // each is wired straight from the matching `create_mic_engine` callback
  // below, never computed here.
  let micSessionActive = $state(false);
  let micAudioStarted = $state(false);
  let micPendingAudio = $state(false);
  let micLastDecodeMs = $state<number | null>(null);
  let micStatusText = $derived(
    mic_status_text({
      audioStarted: micAudioStarted,
      hasSegments: (store?.session.segments.length ?? 0) > 0,
      pendingAudio: micPendingAudio,
      lastDecodeMs: micLastDecodeMs,
      stalled: asrStalled
    })
  );
  // Decided once, at session-ready, from whether this session already has
  // audio persisted — NOT re-read reactively from `store.session.audioFile`
  // afterward, since a live session's own first upload sets that field via
  // `store.set_audio_file` (see below) and would otherwise flip a
  // still-recording session into "review" mode mid-session.
  let audioMode = $state<'live' | 'review'>('live');
  // Task-1 (v0.3 train fixes, Part C): true ONLY for a freshly-started
  // 'live' session (mirrors `plan.startRecorder` below) — demo sessions
  // (ReplayEngine) and resumed/review sessions must keep the plain
  // "listening…" empty state, not the honest recording-status line, per
  // the plan's "demo/replay unchanged" instruction. Deliberately NOT
  // derived from `audioMode` (which is also `'live'` for a demo session,
  // since demo never persists `audioFile` either — see that field's
  // comment above) — `plan.startRecorder` is the one signal that
  // distinguishes a real recorder from a scripted replay.
  let isLiveSession = $state(false);

  // Task 8 fix round 1: `mode` is the start_screen.svelte button (or
  // past-session-list click) the user actually used. The recorder/engine
  // gating decision itself is NOT made inline here anymore — it's
  // `session_mode_plan(mode, settingsEngine)` (session_mode_plan.ts), a
  // pure function unit-tested against the full demo/live/resume x
  // recorder/engine matrix, specifically because the inline version of
  // this logic shipped two real bugs (see that module's header comment
  // for both, verbatim from the review that caught them): live sessions
  // silently getting ReplayEngine instead of an empty transcript, and
  // resuming a past demo session silently starting a real audio recorder.
  // This function's only job now is to *apply* the plan.
  function handle_session_ready(session: Session, mode: SessionStartMode): void {
    store = new SessionStore(session);
    audioMode = session.audioFile === null ? 'live' : 'review';

    const plan = session_mode_plan(mode, settingsStore.settings.engine, micReady);
    noMic = plan.noMicChip;
    isLiveSession = plan.startRecorder;
    // v0.3 train-fixes Part B: a fresh/resumed session starts unpaused —
    // matches every other per-session reset in this function (playbackT,
    // factcheckCards, etc. below).
    paused = false;
    pauseStartedAtMs = null;
    // v0.2: a fresh/resumed session starts with no whisper-offline chip
    // showing — `mic_engine.ts`'s `on_unavailable` (below) is the only
    // thing that ever flips this back on, for THIS session's own engine.
    whisperOffline = false;
    // qwen-asr-engine handover: same per-session reset for the stall chip.
    asrStalled = false;
    // live-subtitles handover: same per-session reset for the lag chip —
    // no reading yet until this session's own mic engine reports one.
    micLagMs = null;
    // Live-transcription-visibility fix: same per-session reset — set
    // true below only inside the `plan.startMic` branch; every other
    // branch (no engine, ReplayEngine, review) leaves this false, so
    // transcript_view.svelte's engine-availability `liveStatusText`
    // keeps answering for them, unchanged.
    micSessionActive = false;
    micAudioStarted = false;
    micPendingAudio = false;
    micLastDecodeMs = null;

    if (plan.startRecorder) {
      const activeStore = store;
      audioRecorder = create_audio_recorder(session.id, {
        onRecordingChange: (recording) => {
          activeStore.recording = recording;
        },
        onNoMic: () => {
          noMic = true;
        },
        onAudioUploaded: () => {
          activeStore.set_audio_file('audio.webm');
        }
      });
      void audioRecorder.start();
    } else {
      audioRecorder = null;
    }

    if (plan.startReplay) {
      const activeStore = store;
      const bridge = create_engine_bridge(activeStore);
      const replay = create_replay_engine({ get_speed: () => settingsStore.settings.replaySpeed });
      engine = replay;
      replayNow = plan.replayClock ? () => replay.now() : null;
      micNotifySpeaker = null;
      engine.on('partial', bridge.handle);
      engine.on('segment', bridge.handle);
      void engine.start();
    } else if (plan.startMic) {
      // v0.2 live transcription: the real mic engine, gated entirely by
      // `session_mode_plan`'s `startMic` (settings.engine === 'mic' AND
      // whisper actually ready) — every other live combination falls
      // through to the `else` branch below, running NO engine at all,
      // exactly v0.1's honest "empty transcript" behavior.
      const activeStore = store;
      // v0.2 fix round 1 (Important 1): `driveSpeaker: false` — manual
      // ArrowLeft/ArrowRight keys are the sole source of truth for
      // `currentSpeaker` while the mic engine is running (they already
      // call `store.set_speaker` directly, see the keymap dispatch
      // below), so this bridge must NEVER also call it from an engine
      // event — see engine_bridge.ts's header comment for the
      // transient-misattribution bug this prevents.
      const bridge = create_engine_bridge(activeStore, { driveSpeaker: false });
      // Live-transcription-visibility fix: this session really is a real
      // mic engine — see `micSessionActive`'s own doc comment above for
      // what that flips transcript_view.svelte over to showing.
      micSessionActive = true;
      const mic: MicEngine = create_mic_engine({
        get_current_speaker: () => activeStore.currentSpeaker,
        on_unavailable: () => {
          whisperOffline = true;
        },
        on_stall_change: (stalled) => {
          asrStalled = stalled;
        },
        on_lag_change: (lagMs) => {
          micLagMs = lagMs;
        },
        on_audio_started: () => {
          micAudioStarted = true;
        },
        on_pending_audio_change: (pending) => {
          micPendingAudio = pending;
        },
        on_decode_ms: (ms) => {
          micLastDecodeMs = ms;
        }
      });
      engine = mic;
      replayNow = null;
      micNotifySpeaker = (speaker) => mic.notify_speaker_change(speaker);
      engine.on('partial', bridge.handle);
      engine.on('segment', bridge.handle);
      void engine.start();
    } else {
      engine = null;
      replayNow = null;
      micNotifySpeaker = null;
    }

    // Task 9: register the AI claim pipeline against THIS store instance
    // (captured via `activeStore`, same pattern as the recorder/replay
    // callbacks above) — see `handle_flag_created_for_ai`'s doc comment.
    // A fresh store per `handle_session_ready` call means a stale
    // registration on a discarded store is simply garbage-collected along
    // with it; no unregister needed (same reasoning as those callbacks).
    const aiStore = store;
    aiStore.on_flag_created((flag) => {
      void handle_flag_created_for_ai(aiStore, flag);
    });

    // Task 9: resume interval-summary scheduling from wherever a resumed
    // session's own summaries already left off, rather than from 0 —
    // otherwise reopening a long past session would immediately re-summarize
    // the whole thing on the next interval tick.
    lastSummaryEndT = session.summaries.length > 0 ? Math.max(...session.summaries.map((s) => s.tTo)) : 0;

    // Task 10: a fresh session (or resuming a different one) starts with no
    // docked cards and nothing pinned into either sidebar — any in-flight
    // streams from a PREVIOUS session are torn down by the cleanup effect
    // below (keyed off `store` itself) before this function ever runs
    // again, so there is nothing to abort here.
    factcheckCards = [];
    keptFactCheckIds = new Set();
    factcheckPromptOpen = false;
    selectionPrefill = null;
    selectionSpeaker = null;

    // Ask-the-conversation handover: same per-session reset — any
    // in-flight ask calls from a PREVIOUS session are torn down by the
    // cleanup effect below (keyed off `store` itself) before this
    // function ever runs again.
    askCards = [];
    askPromptOpen = false;
    askPassage = null;
    askPassageSegmentId = null;

    // Final review fix, Important 1: a fresh/resumed session starts with no
    // known playback position — `resolve_review_t` (audio_helpers.ts) now
    // reads this for review-mode `current_t()`, so a stale non-null value
    // left over from a PREVIOUS session's playback must not leak into a
    // newly-opened one's flag/note timestamps before its own audio has
    // fired even one `ontimeupdate`. No `handle_session_ready` re-entry is
    // wired today (`store` never resets to `null` once set — see the
    // `{#if store === null}` gate below), but this reset costs nothing and
    // matches every other per-session reset in this function.
    playbackT = null;

    // Dev-only escape hatch: manual/console-driven store checks without
    // building throwaway UI for it. Stripped from production builds by
    // Vite's `import.meta.env.DEV` dead-code elimination.
    if (import.meta.env.DEV) (window as unknown as { __tw_store: SessionStore }).__tw_store = store;
  }

  // Task 9: Ollama-backed claim extraction + summaries, with graceful
  // degradation (task-9-brief.md). `aiOffline` drives the top bar's "local
  // AI offline" chip — updated via `ollama_offline_next_state`
  // (ai_pipeline.ts) on every completed call, never blindly overwritten,
  // so a `null` "Ollama wasn't even contacted" result leaves it untouched
  // (review fix round 1, Important 4) while a genuine success/failure
  // still reliably sets/clears it per the brief's "chip clears when a
  // later call succeeds."
  let aiOffline = $state(false);
  let lastSummaryEndT = $state(0);

  // Review fix round 1, Important 3: guards `trigger_summary` against
  // overlapping calls (a slow generation left the next interval poll free
  // to re-fire with the same `tFrom`). Plain module-scoped value, not
  // `$state` — nothing renders off it, same rationale as
  // `jumpNonce`/`seekNonce` above.
  const summaryGate = create_in_flight_guard();

  /**
   * Task 5's `on_flag_created` hook, Task 9's consumer: for every newly
   * created flag, ask `/api/llm/claim` for the other speaker's verbatim
   * claim (gated on the AI master toggle, that person's own toggle —
   * task-9-brief.md: "if AI enabled for the flagging person" — AND
   * `should_extract_claim_for_flag`).
   *
   * Review fix round 1, Critical 1: a `dblclick` flag already carries an
   * exact, user-chosen span — running it through this pipeline anyway
   * resolves an unrelated "nearest segment before flagT" and overwrites
   * that deliberate selection. `should_extract_claim_for_flag` (ai_
   * pipeline.ts) restricts this to `source: 'key'` flags only, the ones
   * genuinely created with a null span that needs filling in.
   */
  async function handle_flag_created_for_ai(activeStore: SessionStore, flag: Flag): Promise<void> {
    if (!should_extract_claim_for_flag(flag)) return;
    if (!settingsStore.settings.aiEnabled) return;
    if (!settingsStore.settings.ai[flag.by].enabled) return;

    const result = await fetch_claim({
      context: window_claim_context(activeStore.session.segments, flag.t),
      flagT: flag.t,
      principles: settingsStore.settings.ai[flag.by].principles,
      model: settingsStore.settings.models.claim
    });
    if (!result) return; // our own server unreachable — nothing to degrade, just skip

    aiOffline = ollama_offline_next_state(aiOffline, result.ollamaAvailable);
    if (result.claim !== null) {
      activeStore.update_flag_claim(flag.id, {
        segmentId: result.segmentId,
        claimText: result.claim,
        charStart: result.charStart,
        charEnd: result.charEnd,
        source: result.via === 'llm' ? 'ai' : undefined
      });
    }
  }

  /**
   * Task 9's "summarize now" button + interval timer, both funneling
   * through here. Summarizes `[lastSummaryEndT, current_t()]` — advancing
   * `lastSummaryEndT` only on a genuine success, so a failed/offline
   * attempt doesn't silently drop that stretch of conversation from ever
   * being summarized once Ollama comes back.
   *
   * Review fix round 1, Important 3: `summaryGate` skips this call
   * outright when one is already in flight — without it, a generation
   * slower than `SUMMARY_POLL_MS` let the next poll (or a manual click)
   * re-fire with the identical `[tFrom, tTo]` range, racing the first call
   * and potentially double-adding the same summary.
   */
  async function trigger_summary(trigger: 'interval' | 'manual'): Promise<void> {
    if (!store) return;
    if (!settingsStore.settings.aiEnabled) return;
    if (!summaryGate.try_start()) return;

    try {
      const activeStore = store;
      const tFrom = lastSummaryEndT;
      const tTo = current_t();
      if (tTo <= tFrom) return; // nothing new to summarize

      const result = await fetch_summary({
        segments: activeStore.session.segments,
        tFrom,
        tTo,
        model: settingsStore.settings.models.quick
      });
      if (!result) return;

      aiOffline = ollama_offline_next_state(aiOffline, !result.unavailable);
      if (!result.unavailable && result.text) {
        activeStore.add_summary({ tFrom, tTo, text: result.text, trigger });
        lastSummaryEndT = tTo;
      }
    } finally {
      summaryGate.finish();
    }
  }

  function summarize_now(): void {
    void trigger_summary('manual');
  }

  // Interval-summary polling: checked on a fixed real-time cadence (NOT a
  // `setInterval` keyed to `summaryIntervalMinutes` itself) so a live
  // settings change takes effect on the very next poll — see
  // summary_scheduler.ts's header comment.
  const SUMMARY_POLL_MS = 15000;

  $effect(() => {
    const activeStore = store;
    if (!activeStore) return;
    const id = setInterval(() => {
      if (should_fire_interval_summary(current_t(), lastSummaryEndT, settingsStore.settings.summaryIntervalMinutes)) {
        void trigger_summary('interval');
      }
    }, SUMMARY_POLL_MS);
    return () => clearInterval(id);
  });

  // Task 10: fact-check — quick + deep agents over SSE, docked cards, F to
  // dispatch, contradiction warning, dismiss/keep.
  //
  // Each entry pairs the pure, testable card view-state (`factcheck_
  // reducer.ts`) with the live stream's `abort()` handle — the ONLY thing
  // in this file that isn't reducer-pure, since an in-flight fetch is a
  // real side effect that has to be torn down somewhere. The underlying
  // session record (`store.session.factChecks`) is patched independently,
  // straight off the same SSE events, via `add_fact_check`/`set_fact_check_
  // quick`/`set_fact_check_deep` — see `dispatch_factcheck` below's doc
  // comment for why that happens regardless of what the user does with the
  // floating card (dismiss/keep only affect the card + `deep.status`, never
  // whether the record exists at all).
  let factcheckCards = $state<{ state: FactCheckCardState; handle: FactCheckStreamHandle }[]>([]);
  // "Keep" pins a fact-check into the flagging person's sidebar for the
  // rest of THIS session (task-10-brief.md). Deliberately NOT part of
  // `shared/model.ts`'s `FactCheck` (its fields already fully cover
  // quick/deep/eta/contradicts — see factcheck_reducer.ts's header
  // comment) — this is ephemeral, in-memory UI state, same status as
  // `factcheckCards` itself, so it does not survive a page reload/session
  // resume. A `Set`, replaced (never mutated in place) on every change so
  // Svelte's reactivity sees it.
  let keptFactCheckIds = $state<Set<string>>(new Set());
  let factcheckPromptOpen = $state(false);
  // `TranscriptView` instance, grabbed via `bind:this` below purely to
  // call its exported `resolve_selection()` at the moment `F` is
  // pressed — see that function's doc comment for why this has to be a
  // pull (called on demand) rather than a prop/derived value.
  let transcriptViewRef: TranscriptView | undefined = $state();
  // The normalized selected text, when `F` was pressed over a usable
  // transcript highlight; `null` means "no usable selection" and the
  // prompt falls back to `factcheckPrefill` below — task brief
  // requirement 1 ("selection wins, flag is the fallback"). Cleared
  // again on cancel/dispatch/session-load so a stale highlight can never
  // leak into a later prompt open that has no selection of its own.
  let selectionPrefill = $state<string | null>(null);
  // The speaker attribution fix (ask-the-conversation handover, part 1):
  // the speaker `transcript_view.svelte`'s `resolve_selection()` resolved
  // for the highlight that produced `selectionPrefill` — `null` whenever
  // `selectionPrefill` is also null (no highlight was used at all), AND,
  // separately, whenever there WAS a highlight but it resolves to no
  // single identifiable speaker (spans no one segment, or that segment
  // is itself unattributed). `attribution_for` (factcheck_helpers.ts)
  // is what turns this into `by`; kept in lockstep with `selectionPrefill`
  // — reset at every point that one is.
  let selectionSpeaker = $state<Speaker | null>(null);

  const expandedFactcheckCardIds = $derived(expanded_card_ids(factcheckCards.map((c) => c.state)));

  const factcheckPrefill = $derived.by(() => {
    if (!store) return '';
    const flag = latest_flag(store.session.flags);
    return flag ? excerpt_for(flag, store.session.segments) : '';
  });

  // What actually goes into `<FactCheckPrompt initialText>` — the
  // selection (if `F` was pressed over a real highlight) or, unchanged
  // from before this feature existed, the latest-flag excerpt.
  const factcheckPromptText = $derived(selectionPrefill ?? factcheckPrefill);

  /**
   * Opens the fact-check prompt. `resolved` is whatever
   * `transcriptViewRef.resolve_selection()` returned at the exact moment
   * `F` was pressed (or `null` for the top-bar "fact-check (f)" button,
   * which — being a mouse click on a UI control rather than the `F`
   * gesture the task brief describes — always uses the flag-based
   * prefill; see that button's own comment). Normalizing the text
   * happens here, once, rather than inside `resolve_selection` itself:
   * that function's job is DOM/containment geometry, this file's job is
   * deciding what counts as "no usable selection" (whitespace-only, per
   * `normalize_selected_text`'s doc comment) and falling back to the
   * flag prefill in that case. `selectionSpeaker` is carried straight
   * through unchanged when the text itself survives normalization —
   * whether the highlight resolved to a real speaker or to none is
   * independent of whether its TEXT happened to be whitespace-only.
   */
  function open_factcheck_prompt(resolved: ResolvedSelection | null = null): void {
    if (!store) return;
    const normalized = resolved ? normalize_selected_text(resolved.text) || null : null;
    selectionPrefill = normalized;
    selectionSpeaker = normalized ? resolved!.speaker : null;
    factcheckPromptOpen = true;
  }

  function cancel_factcheck_prompt(): void {
    factcheckPromptOpen = false;
    selectionPrefill = null;
    selectionSpeaker = null;
  }

  function update_factcheck_card(id: string, action: FactCheckCardAction): void {
    factcheckCards = factcheckCards.map((c) => (c.state.id === id ? { ...c, state: factcheck_card_reducer(c.state, action) } : c));
  }

  /** A stream hasn't started yet the instant a card is created (`start_
   *  factcheck_stream` itself never fails to return a handle synchronously,
   *  but the card is appended to the array before that call — see
   *  `dispatch_factcheck` below) — this inert placeholder's `abort()` is a
   *  no-op, immediately overwritten with the real handle in the same
   *  function, so a dismiss click landing in that split-second window
   *  never throws on a missing handle. */
  const NOOP_HANDLE: FactCheckStreamHandle = { abort: () => {} };

  /**
   * Dispatched on Enter in the fact-check prompt. Creates the durable
   * `FactCheck` record up front (`add_fact_check`) and patches it as each
   * SSE event arrives (`set_fact_check_quick`/`set_fact_check_deep`) —
   * this happens whether or not the user ever presses dismiss/keep, so a
   * fact-check that finishes while nobody's watching the card still lands
   * in the session and on the audio timeline's markers
   * (audio_bar.svelte already reads `session.factChecks` unconditionally).
   *
   * `by` is resolved by `attribution_for` (factcheck_helpers.ts), NOT
   * simply the latest flag's side — a highlight-sourced fact-check
   * attributes to the passage it actually came from (`selectionSpeaker`,
   * resolved back in `open_factcheck_prompt` at the moment `F` was
   * pressed), falling back to `listener_for(currentSpeaker)` — never to
   * `latestFlag` — when that highlight names no identifiable speaker
   * (spans no single segment, or names an unattributed one). Only when
   * there was no highlight at all does the prompt's pre-fill and `by`
   * genuinely name the same moment, and `latestFlag.by` is the honestly
   * correct attribution. See `attribution_for`'s own doc comment for the
   * full reasoning this replaces.
   */
  function dispatch_factcheck(question: string): void {
    factcheckPromptOpen = false;
    const hadSelection = selectionPrefill !== null;
    const resolvedSelectionSpeaker = selectionSpeaker;
    selectionPrefill = null;
    selectionSpeaker = null;
    if (!store) return;
    const activeStore = store;

    const by = attribution_for({
      hasSelection: hadSelection,
      selectionSpeaker: resolvedSelectionSpeaker,
      latestFlag: latest_flag(activeStore.session.flags),
      currentSpeaker: activeStore.currentSpeaker
    });
    const t = current_t();
    const id = activeStore.add_fact_check({ t, by, question });
    const deepModel = settingsStore.settings.models.deep;

    factcheckCards = [...factcheckCards, { state: init_factcheck_card(id, question), handle: NOOP_HANDLE }];

    const handle = start_factcheck_stream(
      {
        question,
        context: window_claim_context(activeStore.session.segments, t),
        models: { quick: settingsStore.settings.models.quick, deep: deepModel }
      },
      {
        onQuick: (data) => {
          activeStore.set_fact_check_quick(id, data);
          update_factcheck_card(id, { type: 'quick', result: data });
        },
        onDeepEta: (data) => {
          activeStore.set_fact_check_deep(id, { status: 'running', text: null, model: deepModel, etaMs: data.etaMs, contradicts: false });
          update_factcheck_card(id, { type: 'deep_eta', etaMs: data.etaMs });
        },
        onDeep: (data) => {
          const currentEtaMs = activeStore.session.factChecks.find((fc) => fc.id === id)?.deep?.etaMs ?? null;
          activeStore.set_fact_check_deep(id, {
            status: 'done',
            text: data.text,
            model: data.model,
            etaMs: currentEtaMs,
            contradicts: data.contradicts
          });
          update_factcheck_card(id, { type: 'deep', result: data });
        }
      }
    );
    factcheckCards = factcheckCards.map((c) => (c.state.id === id ? { ...c, handle } : c));
  }

  function handle_factcheck_dismiss(id: string): void {
    factcheckCards.find((c) => c.state.id === id)?.handle.abort();
    update_factcheck_card(id, { type: 'dismiss' });
    if (!store) return;
    const fc = store.session.factChecks.find((f) => f.id === id);
    store.set_fact_check_deep(id, {
      status: 'dismissed',
      text: fc?.deep?.text ?? null,
      model: fc?.deep?.model ?? settingsStore.settings.models.deep,
      etaMs: fc?.deep?.etaMs ?? null,
      contradicts: fc?.deep?.contradicts ?? false
    });
  }

  function handle_factcheck_keep(id: string): void {
    update_factcheck_card(id, { type: 'keep' });
    keptFactCheckIds = new Set(keptFactCheckIds).add(id);
  }

  // Same "tear down the external resource when this session ends" pattern
  // as the recorder/engine cleanup effects below: any fact-check streams
  // still in flight when the session is replaced (or the app unmounts)
  // are aborted rather than left to complete into a store nobody's
  // looking at anymore. Reads `factcheckCards` fresh inside the returned
  // closure (not a snapshot) so it always aborts whatever is current at
  // cleanup time, not just what existed when this effect last ran.
  $effect(() => {
    const activeStore = store;
    if (!activeStore) return;
    return () => {
      for (const c of factcheckCards) c.handle.abort();
    };
  });

  // Ask-the-conversation handover: "did we talk about this before?",
  // "was this contradicted elsewhere?", and free-form ask — all three
  // share one docked card stack + one prompt surface (`A` key).
  //
  // Structural difference from the fact-check cards above: there is no
  // durable session record here (no `shared/model.ts` shape, no markdown
  // round-trip) — retrieval (app/src/lib/retrieval.ts) already ran
  // synchronously by the time a card exists, so a card with its model
  // step never even started, still in flight, or long gone is equally
  // fine to just drop on dismiss; nothing elsewhere in the app reads an
  // ask card's state the way audio_bar.svelte reads `session.
  // factChecks`. Same NOOP-handle-then-overwrite pattern as
  // `dispatch_factcheck` for the same reason: a stream/fetch hasn't
  // started the instant a card is created and appended.
  const NOOP_ASK_HANDLE: AskHandle = { abort: () => {} };
  let askCards = $state<{ state: AskCardState; handle: AskHandle }[]>([]);
  let askPromptOpen = $state(false);
  // The passage the two presets would act on, resolved once at the
  // moment `A` is pressed — same "selection wins, flag is the fallback"
  // rule as `factcheckPromptText`/`selectionPrefill` above, but `null`
  // (not '') when there is truly nothing to offer a preset, so
  // `AskPrompt` can hide the preset buttons entirely rather than
  // dispatching against empty text. `askPassageSegmentId` is carried
  // alongside purely so retrieval can exclude the passage's own source
  // segment from its own results (`find_related_segments`'s
  // `excludeSegmentId`) — `null` whenever the passage came from the
  // flag fallback (no single highlighted segment) rather than a real
  // highlight.
  let askPassage = $state<string | null>(null);
  let askPassageSegmentId = $state<string | null>(null);

  /**
   * Opens the ask prompt. Mirrors `open_factcheck_prompt`'s selection-
   * vs-flag-fallback resolution exactly (same `resolve_selection()`
   * shape, same `normalize_selected_text` normalization) rather than a
   * second implementation of that rule — the only difference is what
   * happens with the result: fact-check treats "no usable text at all"
   * as an editable-but-empty prompt, this treats it as "hide the
   * presets," since a preset dispatched with an empty passage would just
   * search for nothing.
   */
  function open_ask_prompt(resolved: ResolvedSelection | null): void {
    if (!store) return;
    const normalized = resolved ? normalize_selected_text(resolved.text) || null : null;
    if (normalized) {
      askPassage = normalized;
      askPassageSegmentId = resolved!.segmentId;
    } else {
      askPassage = factcheckPrefill || null;
      askPassageSegmentId = null;
    }
    askPromptOpen = true;
  }

  function cancel_ask_prompt(): void {
    askPromptOpen = false;
  }

  function update_ask_card(id: string, action: AskCardAction): void {
    askCards = askCards.map((c) => (c.state.id === id ? { ...c, state: ask_card_reducer(c.state, action) } : c));
  }

  function ask_candidates_from(matches: AskMatch[]): AskCandidate[] {
    return matches.map((m) => ({ segmentId: m.segmentId, speaker: m.speaker, tStart: m.tStart, text: m.text }));
  }

  /**
   * The algorithmic-first retrieval step, shared by all three modes —
   * pure, synchronous, zero network/model involvement (app/src/lib/
   * retrieval.ts). This is what makes a card a complete, useful answer
   * the instant it's created: whatever this returns is what the card
   * shows immediately, whether or not a model call ever follows.
   */
  function ask_matches_for(query: string, excludeSegmentId: string | null): AskMatch[] {
    if (!store) return [];
    return find_related_segments(query, store.session.segments, { excludeSegmentId, limit: 5 }).map((m) => ({
      segmentId: m.segment.id,
      speaker: m.segment.speaker,
      tStart: m.segment.tStart,
      text: m.segment.text,
      score: m.score
    }));
  }

  /**
   * Creates a card from already-computed `matches` and, only when there
   * is at least one match to judge (recall/contradiction) or always
   * (freeform — even zero matches still gets a transcript-only answer
   * attempt, honestly saying "the transcript doesn't say" when that's
   * true; see server/lib/ask.mjs's `build_freeform_prompt`), starts the
   * model step. Shared by all three dispatch functions below rather than
   * duplicated three times.
   */
  function dispatch_ask(mode: AskMode, query: string, matches: AskMatch[]): void {
    const id = `ask-${crypto.randomUUID()}`;
    askCards = [...askCards, { state: init_ask_card(id, mode, query, matches), handle: NOOP_ASK_HANDLE }];

    if (mode !== 'freeform' && matches.length === 0) return; // nothing to judge — card already shows "nothing found"

    update_ask_card(id, { type: 'model_running' });
    const handle = start_ask(
      { mode, question: query, candidates: ask_candidates_from(matches), model: settingsStore.settings.models.quick },
      (result) => {
        if (!result.ok || result.unavailable) {
          update_ask_card(id, { type: 'model_unavailable' });
          return;
        }
        update_ask_card(id, { type: 'model_result', text: result.text ?? '', sameTopic: result.sameTopic, contradicts: result.contradicts });
      }
    );
    askCards = askCards.map((c) => (c.state.id === id ? { ...c, handle } : c));
  }

  function dispatch_ask_recall(passage: string): void {
    askPromptOpen = false;
    if (!store) return;
    dispatch_ask('recall', passage, ask_matches_for(passage, askPassageSegmentId));
  }

  function dispatch_ask_contradiction(passage: string): void {
    askPromptOpen = false;
    if (!store) return;
    dispatch_ask('contradiction', passage, ask_matches_for(passage, askPassageSegmentId));
  }

  function dispatch_ask_freeform(question: string): void {
    askPromptOpen = false;
    if (!store) return;
    dispatch_ask('freeform', question, ask_matches_for(question, null));
  }

  /** No durable record exists for an ask card (see header comment above)
   *  — dismiss aborts any in-flight model call and drops the card
   *  outright, rather than the fact-check cards' "keep it around,
   *  collapsed" treatment (which exists there only because a fact-check
   *  IS a durable session record app.svelte can't un-create). */
  function handle_ask_dismiss(id: string): void {
    askCards.find((c) => c.state.id === id)?.handle.abort();
    askCards = askCards.filter((c) => c.state.id !== id);
  }

  /** Jump to a retrieved match's segment — same `handle_seek`-then-
   *  overwrite-`scrollRequest` ordering as `handle_jump` above, and for
   *  the same reason: `handle_seek`'s own `segment_at(t)` resolution can
   *  land on a neighboring segment, so the match's own (precise)
   *  `segmentId` must win the final scroll/flash target. */
  function handle_ask_jump(match: AskMatch): void {
    handle_seek(match.tStart);
    jumpNonce += 1;
    scrollRequest = { segmentId: match.segmentId, nonce: jumpNonce };
  }

  $effect(() => {
    const activeStore = store;
    if (!activeStore) return;
    return () => {
      for (const c of askCards) c.handle.abort();
    };
  });

  // Stops the recorder (final upload + mic release) when this component
  // unmounts or `audioRecorder` is replaced — mirrors `store.flush()`'s
  // "don't lose the tail end" intent for autosave. Doesn't cover a closed
  // tab/browser-crash (see audio_recorder.ts's header comment on the
  // `pagehide` best-effort path and its honest limits).
  $effect(() => {
    const rec = audioRecorder;
    if (!rec) return;
    return () => {
      void rec.stop();
    };
  });

  // Task 8: same pattern as the recorder cleanup above — stops the engine
  // (clearing its pending replay timer) when this component unmounts or
  // `engine` is replaced by a later `handle_session_ready` call, so a
  // stale engine never keeps ticking into a store that's no longer live.
  $effect(() => {
    const eng = engine;
    if (!eng) return;
    return () => {
      eng.stop();
    };
  });

  // Fix round 2 (task-8-report.md): autosave's max-wait ceiling
  // (autosave.ts) bounds how long unsaved activity can go unpersisted to
  // 10s, but a tab closed/backgrounded *within* that window still loses
  // whatever hasn't been written yet. `pagehide` covers a closed/navigated
  // tab; `visibilitychange` -> `hidden` additionally covers a backgrounded
  // tab that never actually unloads (switching apps, closing a laptop lid)
  // — same rationale as audio_recorder.ts's own best-effort `pagehide`
  // upload. `store.flush()` (session_store.svelte.ts) already exists for
  // exactly this; this is just wiring it up, no new save logic.
  $effect(() => {
    const activeStore = store;
    if (!activeStore) return;
    const flush_now = () => {
      void activeStore.flush();
    };
    const handle_visibility_change = () => {
      if (document.visibilityState === 'hidden') flush_now();
    };
    document.addEventListener('visibilitychange', handle_visibility_change);
    window.addEventListener('pagehide', flush_now);
    return () => {
      document.removeEventListener('visibilitychange', handle_visibility_change);
      window.removeEventListener('pagehide', flush_now);
    };
  });

  const HOVER_SHOW_PX = 8;
  // Task 14 fix: the grace window between the pointer leaving the header
  // (or focus leaving it) and the bar actually retreating — long enough
  // that moving between two adjacent fields, or a quick glance away and
  // back, never flickers, short enough that it still reads as "closing."
  const HIDE_GRACE_MS = 300;

  // Task 6 fix (still true, mechanism changed by Task 14 below): the bar
  // holds ~10 focusable settings inputs, so focus alone must be able to
  // keep it open regardless of where the cursor physically sits — losing
  // that would trap focus in a now-invisible field and, worse, leave
  // `is_typing_target` swallowing every global key with nothing visible on
  // screen to explain why.
  //
  // Task 14 fix: `hoverShow`/`HOVER_HIDE_PX` used to retreat the bar the
  // moment `clientY` passed 64px — which is "near the top of the SCREEN,"
  // not "inside the BAR," so moving the pointer DOWN into the bar's own
  // fields (well past 64px) slid it shut under the cursor. The hover half
  // of visibility is now `top_bar_visibility.ts`'s pure reducer, driven by
  // the header's actual `pointerenter`/`pointerleave` hit-testing (plus a
  // `pointer_outside` fallback for a pointer that flicks past the header
  // without ever entering it) instead of a coordinate guess, with a short
  // grace delay before a leave/blur actually hides it. See that module's
  // header comment for the full state machine.
  let topBarState = $state(init_top_bar_state());
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  let topBarVisible = $derived(top_bar_visible(topBarState));

  // `pendingHideAt` is data, not a live timer (kept that way so the
  // reducer itself stays pure/testable) — this is the one place that
  // turns a deadline into an actual `tick`. Re-invoked after every event
  // so a canceled/rescheduled deadline always gets exactly one live
  // `setTimeout` racing it, never zero and never more than one.
  function schedule_hide_check(pendingHideAt: number | null) {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (pendingHideAt === null) return;
    const delay = Math.max(1, pendingHideAt - Date.now());
    hideTimer = setTimeout(() => {
      topBarState = top_bar_reducer(topBarState, { type: 'tick', now: Date.now() });
      schedule_hide_check(topBarState.pendingHideAt);
    }, delay);
  }

  function apply_top_bar_event(event: TopBarEvent) {
    topBarState = top_bar_reducer(topBarState, event);
    schedule_hide_check(topBarState.pendingHideAt);
  }

  $effect(() => {
    return () => {
      if (hideTimer !== null) clearTimeout(hideTimer);
    };
  });

  function handle_mousemove(event: MouseEvent) {
    if (event.clientY <= HOVER_SHOW_PX) {
      apply_top_bar_event({ type: 'edge_hover' });
    } else if (!topBarState.overHeader) {
      // Covers a pointer that never actually enters the header's hit-test
      // region at all (a fast flick straight past it) — see
      // top_bar_visibility.ts's `pointer_outside` doc comment.
      apply_top_bar_event({ type: 'pointer_outside', now: Date.now(), graceMs: HIDE_GRACE_MS });
    }
  }

  function handle_header_pointerenter() {
    apply_top_bar_event({ type: 'pointer_enter' });
  }

  function handle_header_pointerleave() {
    apply_top_bar_event({ type: 'pointer_leave', now: Date.now(), graceMs: HIDE_GRACE_MS });
  }

  function handle_header_focusin() {
    apply_top_bar_event({ type: 'focus_in' });
  }

  function handle_header_focusout() {
    apply_top_bar_event({ type: 'focus_out', now: Date.now(), graceMs: HIDE_GRACE_MS });
  }

  function handle_keydown(event: KeyboardEvent) {
    // `is_typing_target` now lives in keymap.ts (Task 5) — imported here
    // rather than duplicated, since this is the exact same rule Task 5's
    // key map itself suppresses on.
    if (is_typing_target(event.target)) return;
    if (event.key === ',') {
      apply_top_bar_event({ type: 'toggle_pin' });
    } else if ((event.key === 'f' || event.key === 'F') && !factcheckPromptOpen && !askPromptOpen && store) {
      // Task 10: `F` opens the fact-check prompt (global-constraints.md's
      // fixed key map — ArrowLeft/Right/ShiftLeft/Right/Space — is a
      // separate, older contract owned by keymap.ts; `F` was never part of
      // it, so it's handled here alongside this file's other single-key
      // app-level shortcut, `,`). Guarded on `factcheckPromptOpen` (and,
      // ask-the-conversation handover, `askPromptOpen`, its sibling
      // surface — the two must never be open at once) so a held/repeating
      // `F` while a prompt is already open doesn't matter — either
      // prompt's own `<input>` would swallow it via `is_typing_target`
      // anyway once focused, but this guard also covers the one-frame
      // window before that focus actually lands.
      event.preventDefault();
      // Read the current highlight NOW, synchronously, before anything
      // else runs — a text selection is not reactive state (`$derived`
      // never sees it, unlike `store.session.flags`), and opening the
      // prompt below focuses+selects its own `<input>`, which would
      // otherwise clobber `window.getSelection()` before this file ever
      // got to look at it. `transcriptViewRef` is null only before the
      // shell has rendered its first `<TranscriptView>` (i.e. `!store`,
      // already guarded above), so this is always safe to call once we
      // get here.
      const selection = transcriptViewRef?.resolve_selection() ?? null;
      open_factcheck_prompt(selection);
    } else if ((event.key === 'a' || event.key === 'A') && !factcheckPromptOpen && !askPromptOpen && store) {
      // Ask-the-conversation handover: `A` opens the ask prompt — free
      // ("a" is not used by any existing binding: ArrowLeft/Right/Shift/
      // Space/`F`/`,` are all accounted for above and in keymap.ts).
      // Same synchronous-read-before-focus-steal reasoning as `F` above.
      event.preventDefault();
      const selection = transcriptViewRef?.resolve_selection() ?? null;
      open_ask_prompt(selection);
    }
  }

  // Task 7: real seek behavior. Fired from three places — transcript_
  // view.svelte's timestamp-gutter click, side_panel.svelte's flag-jump
  // click (via `handle_jump` below), and audio_bar.svelte's own
  // click/drag on the timeline. Two effects, both idempotent to fire
  // redundantly (a repeat seek to the same t is a harmless no-op on
  // either side):
  //   - `seekRequest` (nonce-bumped, same contract as `scrollRequest`
  //     below) -> audio_bar.svelte applies it to `audioEl.currentTime`.
  //     A no-op in live mode (no `<audio>` element exists there).
  //   - `scrollRequest` -> transcript_view.svelte scrolls+flashes the
  //     segment `segment_at` resolves for this `t`. This is what makes a
  //     *gutter*-originated or *audio-bar*-originated seek (neither of
  //     which has a `segmentId` to hand in) scroll the transcript at all.
  //     `handle_jump` (below) calls this FIRST and then overwrites
  //     `scrollRequest` with the flag's own `segmentId` — the flag's
  //     `t` is when the user reacted, not the flagged segment's own
  //     `tStart`/`tEnd` (see keymap.ts's `decide_key`: `t: now`), so
  //     `segment_at(segments, flag.t)` can resolve to a *different*,
  //     later segment than the one actually flagged whenever the
  //     reaction lands after the segment ends (the common case). Fix
  //     round 1 (Task 12 review): this used to run in the opposite
  //     order — `handle_seek`'s bump landing last and winning — which
  //     flashed/scrolled to that neighboring segment instead of the
  //     flagged one.
  //
  // `scrollRequest`/`jumpNonce` themselves are Task 5's sidebar
  // jump-to-segment contract (declared here, ahead of both `handle_seek`
  // and `handle_jump` below, since both now write to them).
  let scrollRequest = $state<ScrollRequest | null>(null);
  let jumpNonce = 0;

  let seekRequest = $state<{ t: number; nonce: number } | null>(null);
  let seekNonce = 0;

  function handle_seek(t: number): void {
    seekNonce += 1;
    seekRequest = { t, nonce: seekNonce };
    if (store) {
      const seg = segment_at(store.session.segments, t);
      if (seg) {
        jumpNonce += 1;
        scrollRequest = { segmentId: seg.id, nonce: jumpNonce };
      }
    }
  }

  // Task 7: playback-position sync — audio_bar.svelte's `<audio>`
  // `ontimeupdate` forwards here, and this forwards straight into
  // transcript_view.svelte's `currentPlaybackT` prop for the faint
  // current-segment underline + follow-if-pinned scroll. `null` in live
  // mode (audio_bar never calls this there — no `<audio>` element exists
  // to time-update from).
  let playbackT = $state<number | null>(null);

  function handle_playback_time(t: number): void {
    playbackT = t;
  }

  // Task 5: global key map (ArrowLeft/ArrowRight/ShiftLeft/ShiftRight/
  // Space) — bound only while a session is live (`store` non-null) via an
  // effect keyed off `store` itself, so it attaches/detaches cleanly
  // across the StartScreen <-> shell transition without leaking a
  // listener that dispatches into a stale/nonexistent store.
  $effect(() => {
    const activeStore = store;
    if (!activeStore) return;
    return bind_keymap(window, {
      get_state: () => ({
        segments: activeStore.session.segments,
        currentSpeaker: activeStore.currentSpeaker
      }),
      now: () => current_t(),
      dispatch: (action) => {
        if (action.type === 'set_speaker') {
          activeStore.set_speaker(action.speaker);
          // v0.2: a manual ArrowLeft/ArrowRight switch is a turn boundary
          // for the mic engine too — see mic_engine.ts's header comment
          // for why this can't just be a live `store.currentSpeaker` read
          // from inside the engine. No-op (null) for every other engine.
          micNotifySpeaker?.(action.speaker);
        } else {
          activeStore.add_flag(action.flag);
        }
      }
    });
  });

  // Task 5: double-click claim flagging. transcript_view.svelte reports
  // only the geometry (segmentId/charStart/charEnd) — `by`/`t` are this
  // shell's job to fill in (see transcript_view.svelte's header comment),
  // reusing keymap.ts's `listener_for` so Space and dblclick agree on one
  // definition of "the listener."
  function handle_dblclick_flag(span: DblclickFlagSpan): void {
    if (!store) return;
    store.add_flag({
      by: listener_for(store.currentSpeaker),
      segmentId: span.segmentId,
      claimText: null,
      charStart: span.charStart,
      charEnd: span.charEnd,
      source: 'dblclick',
      t: current_t()
    });
  }

  // Task 5: sidebar "jump to this flag" — scroll+flash the transcript
  // (when the flag has a segment) and forward the seek. `jumpNonce`
  // guarantees `scrollRequest` changes even on a repeat click of the same
  // entry — see transcript_view.svelte's `ScrollRequest` doc comment.
  // (`scrollRequest`/`jumpNonce` are declared above, alongside
  // `handle_seek`, which now also writes to them.)
  //
  // Order matters (Task 12 fix round 1): `handle_seek` runs FIRST — it
  // covers the audio-bar seek plus a `segment_at(t)`-derived scroll
  // fallback for flags with no `segmentId` — and then, when the flag DOES
  // have its own `segmentId`, that overwrites `scrollRequest` with a
  // fresh, higher-nonce bump so the flag's own (more precise) segment
  // wins the flash/scroll, not whatever `segment_at` resolves for the
  // flag's reaction-time `t` (see `handle_seek`'s doc comment above).
  function handle_jump(flag: Flag): void {
    handle_seek(flag.t);
    if (flag.segmentId) {
      jumpNonce += 1;
      scrollRequest = { segmentId: flag.segmentId, nonce: jumpNonce };
    }
  }

  // Task 11: "share" — downloads the self-contained export HTML
  // (GET /api/session/:id/export) via fetch + blob, rather than a plain
  // `<a href>` navigation, so this stays a same-tab download with no popup
  // and no dependency on the browser's own Content-Disposition handling
  // for same-origin fetches. `shareError` surfaces a fetch failure (e.g.
  // server unreachable) the same low-key way `errorMsg` does on the start
  // screen — no toast system exists in this app to route through instead.
  let shareError = $state<string | null>(null);

  async function share_session(): Promise<void> {
    if (!store) return;
    shareError = null;
    const id = store.session.id;
    try {
      const res = await fetch(`/api/session/${id}/export`);
      if (!res.ok) throw new Error(`export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `talkweave-${id}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      shareError = 'Could not export this session.';
    }
  }
</script>

<svelte:window onmousemove={handle_mousemove} onkeydown={handle_keydown} />

{#if store === null}
  <StartScreen onready={handle_session_ready} />
{:else}
  <div class="shell" data-session-id={store.session.id}>
    <header
      class="top-bar"
      class:visible={topBarVisible}
      aria-hidden={!topBarVisible}
      inert={!topBarVisible}
      onpointerenter={handle_header_pointerenter}
      onpointerleave={handle_header_pointerleave}
      onfocusin={handle_header_focusin}
      onfocusout={handle_header_focusout}
    >
      <div class="header-row">
        <span class="wordmark">talkweave</span>
        <SessionHeader
          title={store.session.title}
          ontitlechange={(title) => store?.set_title(title)}
          startedAt={store.session.startedAt}
          recording={store.recording}
        />
        <button class="summarize-btn" type="button" onclick={summarize_now}>summarize now</button>
        <!-- A mouse click, not the `F` keyboard gesture the highlight-
             prefill feature is scoped to (task brief) — always opens
             with the flag-based prefill, same as before this feature
             existed, regardless of any incidental page selection. -->
        <button class="summarize-btn" type="button" onclick={() => open_factcheck_prompt(null)}>fact-check (f)</button>
        <!-- Same "mouse click always uses the flag-based fallback, not
             whatever's incidentally selected" reasoning as the fact-check
             button above. -->
        <button class="summarize-btn" type="button" onclick={() => open_ask_prompt(null)}>ask (a)</button>
        <button class="summarize-btn" type="button" onclick={share_session}>share</button>
        <!-- qwen-asr-engine handover, Task B item 2: always-on, regardless
             of session mode. See `engineIndicator`'s doc comment above. -->
        <span class="status-chip">{engineIndicator}</span>
        {#if shareError}
          <span class="status-chip">{shareError}</span>
        {/if}
        {#if aiOffline}
          <span class="status-chip">local AI offline</span>
        {/if}
        {#if whisperOffline}
          <span class="status-chip">mic transcription offline</span>
        {/if}
        {#if asrStalled}
          <span class="status-chip">mic transcription stalled: no output for a while, check the ASR engine</span>
        {/if}
        {#if lagLabel}
          <span class="status-chip" title="how far the transcript is running behind the live audio">{lagLabel}</span>
        {/if}
        <button
          class="gear"
          type="button"
          aria-label="settings"
          onclick={() => apply_top_bar_event({ type: 'toggle_pin' })}
        >
          &#9881;
        </button>
      </div>
      <SettingsDrawer
        names={store.session.names}
        onnameschange={(patch) => store?.set_names(patch)}
        settings={settingsStore}
      />
    </header>

    <div class="columns">
      <aside class="side-panel side-panel--left">
        <SidePanel
          side="L"
          name={store.session.names.L}
          flags={store.flags_for('L')}
          notes={store.session.notes.filter((n) => n.by === 'L')}
          factChecks={store.session.factChecks.filter((fc) => fc.by === 'L' && keptFactCheckIds.has(fc.id))}
          segments={store.session.segments}
          now={current_t}
          onjump={handle_jump}
          onnote={(input) => store?.add_note(input)}
        />
      </aside>

      <main class="center-column">
        <div class="content-wrapper">
          <SummaryDividers summaries={store.session.summaries} />
          <TranscriptView
            bind:this={transcriptViewRef}
            segments={store.session.segments}
            flags={store.session.flags}
            currentSpeaker={store.currentSpeaker}
            onseek={handle_seek}
            ondblclickflag={handle_dblclick_flag}
            {scrollRequest}
            currentPlaybackT={playbackT}
            {isLiveSession}
            {liveStatusText}
            pauses={store.session.pauses}
            {micSessionActive}
            {micStatusText}
          />
        </div>
      </main>

      <aside class="side-panel side-panel--right">
        <SidePanel
          side="R"
          name={store.session.names.R}
          flags={store.flags_for('R')}
          notes={store.session.notes.filter((n) => n.by === 'R')}
          factChecks={store.session.factChecks.filter((fc) => fc.by === 'R' && keptFactCheckIds.has(fc.id))}
          segments={store.session.segments}
          now={current_t}
          onjump={handle_jump}
          onnote={(input) => store?.add_note(input)}
        />
      </aside>
    </div>

    {#if factcheckCards.length > 0}
      <!-- Task 10: docked above the bottom bar, right side. Newest card
           last in `factcheckCards` (append-only) but rendered top-to-
           bottom newest-first (`flex-direction: column-reverse`) so a
           freshly dispatched card appears at the bottom, right above the
           audio bar, and older ones stack upward — matching the visual
           rhythm of a chat/notification stack. -->
      <div class="factcheck-stack">
        {#each factcheckCards as c (c.state.id)}
          <FactCheckCard
            card={c.state}
            expanded={expandedFactcheckCardIds.has(c.state.id)}
            ondismiss={handle_factcheck_dismiss}
            onkeep={handle_factcheck_keep}
          />
        {/each}
      </div>
    {/if}

    {#if askCards.length > 0}
      <!-- Same docked-stack idiom as .factcheck-stack, mirrored on the
           LEFT so the two never overlap — see that block's own comment
           for the newest-at-bottom / column-reverse reasoning, identical
           here. No expand/collapse tiering: unlike fact-check cards, a
           dismissed ask card is simply removed (see handle_ask_dismiss's
           doc comment), so there is no "settled but still present" state
           to collapse in the first place. -->
      <div class="ask-stack">
        {#each askCards as c (c.state.id)}
          <AskCard card={c.state} ondismiss={handle_ask_dismiss} onjump={handle_ask_jump} />
        {/each}
      </div>
    {/if}

    <footer class="bottom-bar">
      <AudioBar
        session={store.session}
        sessionId={store.session.id}
        mode={audioMode}
        liveT={current_t}
        {noMic}
        {paused}
        {isLiveSession}
        onseek={handle_seek}
        onplaybacktime={handle_playback_time}
        onpausetoggle={handle_pause_toggle}
        {seekRequest}
      />
    </footer>
  </div>

  {#if factcheckPromptOpen}
    <FactCheckPrompt
      initialText={factcheckPromptText}
      fromSelection={selectionPrefill !== null}
      onsubmit={dispatch_factcheck}
      oncancel={cancel_factcheck_prompt}
    />
  {/if}

  {#if askPromptOpen}
    <AskPrompt
      passage={askPassage}
      fromSelection={askPassageSegmentId !== null}
      onrecall={dispatch_ask_recall}
      oncontradiction={dispatch_ask_contradiction}
      onfreeform={dispatch_ask_freeform}
      oncancel={cancel_ask_prompt}
    />
  {/if}
{/if}

<style>
  .shell {
    position: relative;
    display: grid;
    grid-template-rows: 1fr 64px;
    height: 100vh;
    width: 100vw;
    background: #000;
    color: #e8e8e4;
    overflow: hidden;
  }

  .top-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    max-height: 80vh;
    overflow-y: auto;
    background: #000;
    border-bottom: 1px solid #1a1a1a;
    transform: translateY(-100%);
    transition: transform 160ms ease-out;
  }

  .top-bar.visible {
    transform: translateY(0);
  }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 20px;
  }

  .wordmark {
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    color: #e8e8e4;
    opacity: 0.8;
    flex-shrink: 0;
  }

  .gear {
    background: none;
    border: none;
    color: #e8e8e4;
    opacity: 0.6;
    font-size: 16px;
    cursor: pointer;
    line-height: 1;
    padding: 4px;
  }

  .gear:hover {
    opacity: 1;
  }

  .summarize-btn {
    flex-shrink: 0;
    background: none;
    border: 1px solid #2a2a26;
    color: #8a8a86;
    font-size: 11px;
    letter-spacing: 0.02em;
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
  }

  .summarize-btn:hover {
    border-color: #ffb84d;
    color: #ffb84d;
  }

  /* Small dim pill for any header-row status text: export/AI/mic-offline
     warnings originally (still the same look for those), plus the
     always-on ASR engine indicator (qwen-asr-engine handover) and the
     mic-stall chip. Renamed from `.ai-offline-chip`: it was never really
     AI- or offline-specific, just "the one low-key status pill idiom",
     and the rename just makes that honest now that a neutral, non-alarm
     use exists alongside the warning ones. */
  .status-chip {
    flex-shrink: 0;
    color: #6a6a66;
    font-size: 11px;
    border: 1px solid #2a2a26;
    border-radius: 999px;
    padding: 3px 10px;
  }

  .columns {
    display: grid;
    grid-template-columns: 280px 1fr 280px;
    height: 100%;
    overflow: hidden;
  }

  .side-panel {
    padding: 24px 16px;
    overflow-y: auto;
  }

  .center-column {
    display: flex;
    justify-content: center;
    padding: 24px 0;
    /* No overflow here: exactly one element in this tree scrolls, and
       that's transcript_view's own internal .scroll-area (its pin-to-
       bottom logic reads scrollTop/scrollHeight off an element it owns).
       This column and .content-wrapper below are non-scrolling flex
       containers that just size the transcript to the available height. */
    overflow: hidden;
    min-height: 0;
  }

  /* 760px content cap for the center column — later tasks (summary
     dividers, etc.) drop their markup in here to inherit the width
     constraint. Full-height flex column so a flex:1 child (the transcript)
     can claim the remaining space and scroll internally. */
  .content-wrapper {
    width: 100%;
    max-width: 760px;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .bottom-bar {
    display: flex;
    align-items: center;
    height: 64px;
    border-top: 1px solid #1a1a1a;
  }

  /* Task 10: docked above the bottom bar, right side (task-10-brief.md).
     Positioned against `.shell` (the nearest `position: relative`
     ancestor), `bottom` offset by the bottom bar's own fixed 64px height
     plus a small gap so it never overlaps the audio timeline. */
  .factcheck-stack {
    position: absolute;
    right: 20px;
    bottom: 80px;
    z-index: 5;
    display: flex;
    flex-direction: column-reverse;
    gap: 10px;
    max-height: calc(100vh - 160px);
    overflow-y: auto;
  }

  /* Ask-the-conversation handover: same docked-stack mechanics as
     .factcheck-stack above, mirrored on the LEFT so the two can never
     overlap even when both have cards showing at once. */
  .ask-stack {
    position: absolute;
    left: 20px;
    bottom: 80px;
    z-index: 5;
    display: flex;
    flex-direction: column-reverse;
    gap: 10px;
    max-height: calc(100vh - 160px);
    overflow-y: auto;
  }

</style>
