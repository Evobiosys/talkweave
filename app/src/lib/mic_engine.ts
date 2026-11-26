// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — v0.2 live transcription (Candidate A, see
// DEVLOG/v02-live-transcription_of-talkweave_handover.md). Real
// TranscriptionEngine for the 'mic' engine setting, replacing the v0.1
// no-op placeholder this file used to be (git history has that version).
//
// Two independent HTTP flows to server/lib/whisper_stream.mjs (via
// server/lib/router.mjs's mic routes), not one duplex connection:
//   - PCM audio UP: `POST /api/mic/audio/:id`, one small `application/
//     octet-stream` body per captured buffer (raw 16kHz mono PCM16 —
//     app/src/lib/pcm_helpers.ts's `encode_pcm16_chunk`).
//   - Transcription events DOWN: `GET /api/mic/stream/:id`, consumed via
//     `fetch`+`AbortController` reading a streamed response body — same
//     pattern as factcheck_client.ts's `start_factcheck_stream` (this
//     module reuses that file's `parse_sse_block`), and deliberately NOT
//     the browser's native `EventSource`: `EventSource` auto-reconnects
//     on a dropped connection, which would silently re-attach to a stream
//     this engine already called `/api/mic/stop/:id` on.
// A single fetch with a duplex (streamed-both-ways) body was considered
// and rejected: it needs `duplex: 'half'`, a newer/less predictable fetch
// option, for no real benefit here — audio-up and events-down have
// completely different cadences and failure modes, and two plain
// request/response flows are each independently simple to reason about
// and test.
//
// Audio capture: `ScriptProcessorNode`, not `AudioWorklet`. `AudioWorklet`
// is the modern replacement, but it needs `audioContext.audioWorklet.
// addModule(url)` to load a separate worklet script — a build-time asset
// whose URL has to survive Vite's bundling, a real integration risk that
// would only ever surface as a 404 at RUNTIME (npm run build stays green
// regardless). `ScriptProcessorNode` is deprecated but needs zero extra
// build surface, is exercised directly by this task's own headless
// Playwright test (Chromium's `--use-fake-device-for-media-stream`, same
// flag Task 7's `audio_recorder.ts` verification already relies on), and
// the handover explicitly names both as an acceptable design choice —
// picking the one this task can actually prove works end-to-end.
//
// Speaker attribution stays fully manual (handover step 4 — do NOT add
// diarization here). See mic_engine_core.ts's header comment for the
// race its `MicTurnTracker` exists to prevent: a manual ArrowLeft/
// ArrowRight speaker switch is a TURN BOUNDARY — `notify_speaker_change`
// (called from app.svelte's keymap dispatch, alongside `store.
// set_speaker`) forces the server-side window to flush immediately
// (`POST /api/mic/flush/:id`) via `MicTurnTracker.request_speaker_change`,
// but the actual `openSpeaker` promotion only happens once that flush's
// own `final` SSE event is consumed — so the utterance that was already
// in flight at switch time keeps reporting the speaker who was actually
// talking during it, not the one the user just switched to. The ONE
// exception: the very first speaker ever chosen this session promotes
// immediately with no flush at all (see mic_engine_core.ts's "fix round
// 2" comment), since there is no real outgoing speaker's utterance to
// protect yet, and flushing there used to just split the window and drop
// whatever was said before the keypress.
//
// Browser-only, same as audio_recorder.ts: neither `fetch`-driven SSE
// consumption's DOM-free half nor the pure turn-tracker
// (mic_engine_core.ts) nor pcm_helpers.ts's math needs a browser to test
// (all covered by `npm test`) — but `getUserMedia`/`AudioContext`/
// `ScriptProcessorNode` do, so `start()`'s actual capture path is only
// ever exercised by headless Playwright, not vitest (this repo's vitest
// config has no jsdom, and even jsdom doesn't implement Web Audio).

import type { EngineEvent, EngineEventName, TranscriptionEngine } from '../../../shared/engine';
import type { Speaker } from '../../../shared/model';
import { parse_sse_block } from './factcheck_client';
import { create_mic_turn_tracker } from './mic_engine_core';
import { encode_pcm16_chunk } from './pcm_helpers';

const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

export interface MicEngine extends TranscriptionEngine {
  /** Call whenever the manual ArrowLeft/ArrowRight keymap sets a new
   *  speaker (alongside `store.set_speaker`) — see this module's header
   *  comment for why a speaker switch must be routed through here rather
   *  than left to a live `store.currentSpeaker` read. No-op before
   *  `start()`/after `stop()`. */
  notify_speaker_change(speaker: Speaker | null): void;
}

export interface MicEngineOptions {
  /** Read once, at `start()`, to seed the turn tracker's initial speaker
   *  — handover step 4: "whatever currentSpeaker the keymap has set at
   *  the moment the utterance starts." */
  get_current_speaker: () => Speaker | null;
  /** Fired at most once per `start()`/`stop()` lifetime: `POST
   *  /api/mic/start` failed (whisper unavailable — the 503 path,
   *  `server/lib/router.mjs`'s `handle_mic_start`), the mic itself was
   *  denied/unavailable for THIS engine's own capture stream, or the SSE
   *  connection dropped unexpectedly mid-session (server process died,
   *  network hiccup). app.svelte wires this to a "mic transcription
   *  offline" chip — same visual convention as the existing "local AI
   *  offline" chip (handover step 6's graceful-degradation requirement:
   *  "behave like v0.1's live session," not throw/crash). */
  on_unavailable?: () => void;
  /**
   * qwen-asr-engine handover, Task B ("make the failure state legible
   * rather than silent": the v0.2 ledger's deferred "consecutive-failure
   * chip", named again in this handover): fires `true` when no SSE event
   * of ANY kind (partial or final, empty text or not) has arrived for
   * `stallMs` since the stream started or since the last one, and `false`
   * the instant a fresh event arrives.
   *
   * Deliberately NOT a count of failed transcriptions: `server/lib/
   * whisper_stream.mjs`'s `tick()` emits an event every tick regardless
   * of outcome (`default_whisper_run`/the qwen adapter both resolve `''`
   * rather than throw), so a genuinely silent room and a completely
   * broken backend both look identical tick-to-tick. An empty string is
   * not distinguishable from a failure at that layer without the server
   * exposing a separate ok/error signal, which would mean touching
   * server/ (out of this task's scope, and Task A's checklist doesn't add
   * one either). What IS unambiguous from here: whether an SSE event of
   * ANY shape keeps arriving at all. The tick loop fires on a fixed
   * cadence once any audio is buffered (see whisper_stream.mjs's `tick()`,
   * which returns early only on `pcmBytes === 0`), so once capture starts,
   * silence stops ticks emitting nothing; only a dead loop, a stuck
   * connection, or a server-side crash stops events arriving at all. This
   * chip means "the pipe went quiet," which is the exact "silent
   * chip-less transcript" failure mode the v0.2 review flagged. It does
   * NOT mean "nobody is talking."
   */
  on_stall_change?: (stalled: boolean) => void;
  /**
   * live-subtitles handover, item 4 ("show the lag … so a slow model
   * reads as slow rather than as broken"): fires on every SSE event
   * (partial or final, empty text or not — deliberately not gated on
   * `handle_server_event`'s own empty-text drop, since a quiet tick is
   * still useful lag information) with how many milliseconds REAL time
   * has run ahead of the transcript's own `tEnd` clock.
   *
   * `tEnd` is seconds since `POST /api/mic/start` on the SERVER's clock
   * (whisper_stream.mjs's `now_s()`, read at the moment that tick's
   * decode finished); `streamStartedAt` below is this engine's own
   * `Date.now()` read immediately after that same POST resolves — the two
   * clocks start together closely enough (one HTTP round trip apart) that
   * `(now - streamStartedAt) - tEnd*1000` is a fair "how stale is what's
   * on screen right now" number, not a precise one. This is intentionally
   * NOT the same thing as `on_stall_change`: a healthy-but-slow qwen3-asr
   * round trip reports a real, nonzero, perfectly normal lag here without
   * ever tripping the (much larger) stall threshold.
   */
  on_lag_change?: (lagMs: number) => void;
  /**
   * live-transcription-visibility fix ("An honest status line, which is
   * the user's explicit demand" — never a reassuring placeholder): fires
   * exactly ONCE per `start()`/`stop()` lifetime, the moment real audio is
   * first captured from the mic (the `ScriptProcessorNode`'s
   * `onaudioprocess` firing for the first time — see `start_capture`
   * below). This is the one honest way to distinguish "waiting for audio"
   * from "audio arriving" from inside this module: `getUserMedia`
   * resolving only means permission was granted, not that any sample has
   * actually been pulled off the device yet.
   */
  on_audio_started?: () => void;
  /**
   * live-transcription-visibility fix: fires `true` the moment audio has
   * been captured MORE RECENTLY than the last SSE event this engine
   * received, and `false` the instant a fresh SSE event arrives — a plain
   * fact about what is currently sitting in the pipeline (captured-but-
   * not-yet-reflected-in-any-transcript-event), not a guess about whether
   * the server happens to be mid-decode at this exact millisecond (this
   * module has no way to know that without a second server-pushed signal,
   * and inventing one wasn't worth the protocol change — see
   * mic_status.ts's header comment for the full reasoning). Never fires
   * before `on_audio_started` has fired once.
   */
  on_pending_audio_change?: (pending: boolean) => void;
  /**
   * live-transcription-visibility fix ("how long the last decode actually
   * took, if you can measure it, so a slow model reads as slow"): fires
   * with `server/lib/whisper_stream.mjs`'s own measured wall-clock
   * duration of `transcribe_current_window()` (spawn-to-resolve, real
   * milliseconds, not a network-round-trip proxy), read straight off the
   * SSE payload's `decodeMs` field. Fires for every event that carries the
   * field, including an empty-text tick (same "a quiet tick is still real
   * information" convention as `on_lag_change` above) — but the server
   * omits the field entirely for a flush that had nothing buffered (no
   * spawn happened, so there is no real duration to report), and this
   * callback is simply not called for those.
   */
  on_decode_ms?: (ms: number) => void;
  /** Overrides `DEFAULT_STALL_MS` (test-only seam: production callers
   *  never need this; see that constant's doc comment for how it was
   *  picked). */
  stallMs?: number;
  /** How often the watchdog re-checks elapsed time since the last SSE
   *  event. Test-only seam; production default below is prompt without
   *  busy-polling. */
  stallPollMs?: number;
  /** Overrides the wall-clock source `streamStartedAt`/`on_lag_change`
   *  read (default `Date.now`) — test-only seam so a lag calculation can
   *  be asserted exactly rather than only qualitatively; no production
   *  caller ever sets this. */
  now?: () => number;
}

/** Default no-event watchdog threshold for `on_stall_change` above: 90s.
 *  Calibrated against the handover's own measured qwen3-asr throughput
 *  (74s of audio taking 45s to come back, the slowest of the two runs it
 *  reports) plus real margin: a working-but-slow local engine must never
 *  trip this, only a genuinely dead pipeline should. whisper.cpp's
 *  default 20s window cap is comfortably inside this too. */
const DEFAULT_STALL_MS = 90000;

/** Resolves the real `AudioContext` constructor, Safari's vendor-prefixed
 *  fallback, or `undefined` in any environment with neither (this repo's
 *  plain-Node vitest run, most notably) — `typeof` checks throughout so
 *  referencing an undeclared global never throws, same technique
 *  audio_recorder.ts's own `typeof MediaRecorder === 'undefined'` guard
 *  uses. */
function resolve_audio_context_ctor(): typeof AudioContext | undefined {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  if (typeof window !== 'undefined') {
    const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
    if (w.webkitAudioContext) return w.webkitAudioContext;
  }
  return undefined;
}

export function create_mic_engine(options: MicEngineOptions): MicEngine {
  const listeners: Record<EngineEventName, Array<(event: EngineEvent) => void>> = { partial: [], segment: [] };
  const tracker = create_mic_turn_tracker(options.get_current_speaker());

  let stopped = true;
  let unavailableFired = false;
  let streamId: string | null = null;
  let abortController: AbortController | null = null;
  // Stall watchdog (`on_stall_change` above). `streamStartedAt` is the
  // baseline before any event has ever arrived; `lastEventAt` replaces it
  // the moment one does. Both null between sessions.
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const stallPollMs = options.stallPollMs ?? Math.min(5000, stallMs);
  // `on_lag_change`'s clock source — defaults to real `Date.now`, so every
  // production call site behaves exactly as before; only a test that
  // explicitly injects `options.now` sees anything different.
  const nowFn = options.now ?? Date.now;
  let streamStartedAt: number | null = null;
  let lastEventAt: number | null = null;
  let stalled = false;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  // A `notify_speaker_change` that lands before `POST /api/mic/start` has
  // resolved (there IS no `streamId` yet to flush) must not silently drop
  // the request — the tracker's `pendingSpeaker` would then never get
  // promoted (only a `final` event consumption does that), permanently
  // stalling emission for the rest of the session. Set true here, flushed
  // the instant `streamId` becomes known (`start()`, right after it's
  // assigned below).
  let flushPending = false;
  // `on_audio_started`/`on_pending_audio_change` above — both null between
  // sessions (reset in `start()`, same convention as `streamStartedAt`/
  // `lastEventAt`). `audioStartedFired` guards the one-shot callback;
  // `lastAudioCapturedAt` is compared against `lastEventAt` (already
  // tracked above) on EVERY audio capture and EVERY SSE event to recompute
  // `pendingAudio` — see `update_pending_audio`'s doc comment.
  let audioStartedFired = false;
  let lastAudioCapturedAt: number | null = null;
  let pendingAudio = false;

  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: ScriptProcessorNode | null = null;
  let muteNode: GainNode | null = null;

  function fire_unavailable(): void {
    if (unavailableFired) return;
    unavailableFired = true;
    options.on_unavailable?.();
  }

  /** Called for every well-formed SSE block, regardless of what it
   *  contains (even an empty-text tick). See `on_stall_change`'s doc
   *  comment for why "an event arrived at all" is the right signal here,
   *  not "an event with real text arrived." Recovery is reported
   *  immediately on the next event rather than waiting for the next
   *  `check_stall` poll. */
  function mark_event_received(): void {
    lastEventAt = Date.now();
    if (stalled) {
      stalled = false;
      options.on_stall_change?.(false);
    }
    update_pending_audio();
  }

  /**
   * Recomputes `pendingAudio` from the two real timestamps that define it
   * (`lastAudioCapturedAt` vs `lastEventAt`) and fires `on_pending_audio_
   * change` only on an actual flip — called after every audio-capture tick
   * AND after every received SSE event, since either one can change the
   * answer. `pending` is true iff audio has been captured that no received
   * event yet reflects: a fact about pipeline CONTENTS (what's buffered vs
   * what's been reported back), not a claim about server-internal state
   * this module has no visibility into (see `on_pending_audio_change`'s
   * doc comment for why that distinction matters).
   */
  function update_pending_audio(): void {
    const next = lastAudioCapturedAt !== null && (lastEventAt === null || lastAudioCapturedAt > lastEventAt);
    if (next === pendingAudio) return;
    pendingAudio = next;
    options.on_pending_audio_change?.(pendingAudio);
  }

  /** Called from `start_capture`'s `onaudioprocess` handler — the one
   *  place this module can honestly say "real audio samples were just
   *  pulled off the mic," independent of whether the subsequent POST to
   *  the server ever succeeds (see `post_audio_chunk`'s own best-effort
   *  comment: a dropped upload doesn't mean silence, it means one chunk
   *  never reached the transcriber). */
  function mark_audio_captured(): void {
    lastAudioCapturedAt = Date.now();
    if (!audioStartedFired) {
      audioStartedFired = true;
      options.on_audio_started?.();
    }
    update_pending_audio();
  }

  /** Polled every `stallPollMs` while a stream is open. Going stale is
   *  reported once per stall (not re-fired on every subsequent poll);
   *  `mark_event_received` is the only path back to `false`. */
  function check_stall(): void {
    const baseline = lastEventAt ?? streamStartedAt;
    if (baseline === null) return;
    if (!stalled && Date.now() - baseline >= stallMs) {
      stalled = true;
      options.on_stall_change?.(true);
    }
  }

  /** See `on_lag_change`'s doc comment above for the math and what it
   *  can/can't claim to be precise about. No-op before `streamStartedAt`
   *  is known (a stray event arriving before `start()`'s own POST has
   *  resolved — cannot happen in practice, since nothing subscribes to
   *  the SSE stream until after that, but guarded rather than assumed). */
  function report_lag(tEndSeconds: number): void {
    if (streamStartedAt === null) return;
    const elapsedMs = nowFn() - streamStartedAt;
    options.on_lag_change?.(elapsedMs - tEndSeconds * 1000);
  }

  function emit(kind: EngineEventName, event: EngineEvent): void {
    for (const cb of listeners[kind]) cb(event);
  }

  /** One incoming SSE event (`partial`/`final`), after JSON-parsing — see
   *  mic_engine_core.ts's header comment for the speaker-labeling
   *  sequencing this delegates to. `speaker` is emitted verbatim, `null`
   *  included (live-transcription-visibility fix — see mic_engine_core.ts's
   *  "fix round 3": `EngineEvent.speaker` is `Speaker | null`, and text
   *  transcribed before anyone claims a speaker is real, renderable
   *  content, not something this layer gets to silently withhold).  Empty
   *  text (a flush with nothing buffered yet — server/lib/whisper_stream
   *  .mjs's fast path) is dropped WITHOUT emitting a spurious empty
   *  segment, but the tracker still runs first so a pending speaker
   *  promotion is never skipped. */
  function handle_server_event(final: boolean, data: { tStart: number; tEnd: number; text: string }): void {
    const speaker = tracker.label_event(final);
    if (data.text.trim() === '') return;
    const event: EngineEvent = { speaker, tStart: data.tStart, tEnd: data.tEnd, text: data.text, final };
    emit(final ? 'segment' : 'partial', event);
  }

  /** Parses one already-`\n\n`-split SSE block into a typed mic event,
   *  reusing factcheck_client.ts's `parse_sse_block` for the event/data
   *  split itself. Malformed JSON or a payload missing/mistyping a
   *  required field is silently skipped, same "one bad chunk never kills
   *  the stream" contract as every other SSE consumer in this codebase. */
  function dispatch_block(block: string): void {
    const parsed = parse_sse_block(block);
    if (!parsed) return;
    mark_event_received();
    let data: unknown;
    try {
      data = JSON.parse(parsed.data);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    if (typeof d.tStart !== 'number' || typeof d.tEnd !== 'number' || typeof d.text !== 'string') return;
    // Ahead of `handle_server_event`'s own empty-text drop, deliberately —
    // see `on_lag_change`'s doc comment: a quiet tick is still real lag
    // information.
    report_lag(d.tEnd);
    // `decodeMs` is optional (whisper_stream.mjs omits it for a flush that
    // had nothing buffered — no spawn happened, so there's no real
    // duration to report) — see `on_decode_ms`'s doc comment.
    if (typeof d.decodeMs === 'number') options.on_decode_ms?.(d.decodeMs);
    handle_server_event(parsed.event === 'final', { tStart: d.tStart, tEnd: d.tEnd, text: d.text });
  }

  async function consume_sse(id: string, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`/api/mic/stream/${id}`, { signal });
    } catch {
      if (!stopped) fire_unavailable();
      return;
    }
    if (!res.ok || !res.body) {
      if (!stopped) fire_unavailable();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) dispatch_block(block);
      }
      // The server route never closes this stream on its own (see
      // router.mjs's `handle_mic_stream`) — reaching `done` here means the
      // connection dropped for a reason other than OUR OWN `stop()`
      // (server crash, network failure), so it's a genuine mid-session
      // "transcription is no longer happening" event.
      if (!stopped) fire_unavailable();
    } catch {
      // Our own `stop()`'s `abortController.abort()` lands here too —
      // `stopped` is already true by then, so `fire_unavailable` is
      // correctly skipped for a deliberate stop.
      if (!stopped) fire_unavailable();
    }
  }

  function post_audio_chunk(bytes: Uint8Array): void {
    const id = streamId;
    if (!id) return;
    // Wrapped in a `Blob` (with an explicit `BlobPart` cast) rather than
    // passed as a raw `Uint8Array`: this TS/lib.dom version makes
    // `Uint8Array` generic over `ArrayBufferLike` (which also covers
    // `SharedArrayBuffer`), so it no longer structurally satisfies
    // `BodyInit`/`BlobPart` without help — `pcm16_to_bytes`'s own
    // `Uint8Array` is always backed by a plain (never Shared)
    // `ArrayBuffer` at runtime, so the cast is safe, just not something
    // the type checker can infer on its own.
    void fetch(`/api/mic/audio/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([bytes as BlobPart])
    }).catch(() => {
      // Best-effort, same convention as audio_recorder.ts's own upload
      // error handling: one dropped chunk doesn't stop the session, it's
      // simply not transcribed (the growing/rewriting partial text on the
      // NEXT tick still self-corrects from whatever audio did arrive).
    });
  }

  /** Requests the mic (a SEPARATE `getUserMedia` call from
   *  audio_recorder.ts's own — see this module's header comment on why
   *  the two capture paths are independent) and wires a `ScriptProcessorNode`
   *  to encode+POST PCM chunks. No-op in any environment missing
   *  `getUserMedia`/`AudioContext` (this repo's vitest run) — mirrors
   *  audio_recorder.ts's own environment guard. The processor is routed
   *  through a zero-gain `GainNode` to `audioContext.destination`: some
   *  browsers only fire `onaudioprocess` once a `ScriptProcessorNode` is
   *  connected all the way to a real destination, but connecting the RAW
   *  mic signal there directly would audibly echo the speaker's own
   *  voice back through the laptop's speakers mid-conversation — the mute
   *  node keeps the pull-through-the-graph effect without the feedback. */
  function start_capture(): void {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    const AudioContextCtor = resolve_audio_context_ctor();
    if (!AudioContextCtor) return;

    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        if (stopped) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        mediaStream = stream;
        audioContext = new AudioContextCtor();
        sourceNode = audioContext.createMediaStreamSource(stream);
        processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
        muteNode = audioContext.createGain();
        muteNode.gain.value = 0;

        processorNode.onaudioprocess = (e: AudioProcessingEvent) => {
          if (stopped || !audioContext) return;
          const input = e.inputBuffer.getChannelData(0);
          post_audio_chunk(encode_pcm16_chunk(input, audioContext.sampleRate));
          mark_audio_captured();
        };

        sourceNode.connect(processorNode);
        processorNode.connect(muteNode);
        muteNode.connect(audioContext.destination);
      })
      .catch(() => {
        // Denied/unavailable for THIS engine's own stream — the webm
        // sidecar recorder (audio_recorder.ts) has its own independent
        // mic request and its own "no mic" fallback; this only affects
        // whether transcription ever receives audio, not whether the
        // audio recording itself works.
        fire_unavailable();
      });
  }

  function teardown_capture(): void {
    if (processorNode) {
      processorNode.onaudioprocess = null;
      processorNode.disconnect();
      processorNode = null;
    }
    if (muteNode) {
      muteNode.disconnect();
      muteNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (audioContext) {
      const ctx = audioContext;
      audioContext = null;
      void ctx.close().catch(() => {});
    }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      unavailableFired = false;
      flushPending = false;
      streamStartedAt = null;
      lastEventAt = null;
      stalled = false;
      audioStartedFired = false;
      lastAudioCapturedAt = null;
      pendingAudio = false;

      let res: Response;
      try {
        res = await fetch('/api/mic/start', { method: 'POST' });
      } catch {
        fire_unavailable();
        return;
      }
      if (!res.ok) {
        fire_unavailable();
        return;
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        fire_unavailable();
        return;
      }
      const id = body && typeof body === 'object' ? (body as Record<string, unknown>).streamId : undefined;
      if (typeof id !== 'string') {
        fire_unavailable();
        return;
      }
      if (stopped) return; // stop() raced start()'s own await chain

      streamId = id;
      streamStartedAt = nowFn();
      abortController = new AbortController();
      stallTimer = setInterval(check_stall, stallPollMs);
      void consume_sse(id, abortController.signal);
      start_capture();

      // A speaker change requested while `streamId` was still unknown
      // (see `flushPending`'s doc comment above) — send its flush now
      // that there's finally somewhere to send it.
      if (flushPending) {
        flushPending = false;
        void fetch(`/api/mic/flush/${id}`, { method: 'POST' }).catch(() => {});
      }
    },

    stop(): void {
      if (stopped) return;
      stopped = true;

      abortController?.abort();
      abortController = null;

      if (stallTimer !== null) {
        clearInterval(stallTimer);
        stallTimer = null;
      }
      // No `on_stall_change(false)` call here: a deliberate stop is not a
      // recovery, it's the session ending. app.svelte resets its own
      // chip state at the next `handle_session_ready`, same as
      // `whisperOffline`. This just prevents a stale `true` from lingering
      // internally if this engine object were ever reused.
      stalled = false;
      streamStartedAt = null;
      lastEventAt = null;

      const id = streamId;
      streamId = null;
      if (id) {
        void fetch(`/api/mic/stop/${id}`, { method: 'POST' }).catch(() => {});
      }

      teardown_capture();
    },

    on(ev: EngineEventName, cb: (event: EngineEvent) => void): void {
      listeners[ev].push(cb);
    },

    notify_speaker_change(speaker: Speaker | null): void {
      if (stopped) return;
      const changed = tracker.request_speaker_change(speaker);
      if (!changed) return;
      const id = streamId;
      if (id) {
        void fetch(`/api/mic/flush/${id}`, { method: 'POST' }).catch(() => {});
      } else {
        // `start()` hasn't resolved `streamId` yet — remember to flush the
        // moment it does (see `flushPending`'s doc comment above), rather
        // than losing this request.
        flushPending = true;
      }
    }
  };
}
