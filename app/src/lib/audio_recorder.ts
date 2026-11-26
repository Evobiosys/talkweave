// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — Task 7's mic capture + upload adapter over getUserMedia and
// MediaRecorder.
//
// Browser-only: neither API exists in this repo's vitest environment
// (vitest.config.ts has no jsdom, and even jsdom doesn't implement
// MediaRecorder), so this module can't be exercised under `npm test` —
// per task-7-brief.md's own note. Every piece of *logic* that doesn't
// require a real MediaRecorder/MediaStream (mime-type selection, the
// recorder-clock/fallback-clock timebase math) is factored out into
// audio_helpers.ts and unit-tested there; what's left here is thin
// wiring plus chunk/upload bookkeeping, verified end-to-end with headless
// Playwright against the real server using Chromium's
// --use-fake-device-for-media-stream flag (see task-7-report.md for the
// transcript).
//
// Timebase contract (task-7-brief.md: "expose elapsed-time clock as the
// session timebase, t=0 at record start"): `now()` returns seconds since
// whichever instant recording actually anchors to —
//   - mic available: `performance.now()` at the moment `MediaRecorder.
//     start()` was called (as close as this adapter gets to "the audio
//     file's own t=0" — the two are the same instant by construction).
//   - mic denied/unavailable: `performance.now()` at the moment `start()`
//     was called at all (the "no mic" fallback instant).
// Once established, the chosen base is never swapped out later — even if
// the mic drops mid-session (a device error after a successful start),
// `now()` keeps counting from the original recorder-start instant so
// every `Flag`/`Note` timestamped before and after the drop stays on one
// consistent scale (app.svelte's `current_t()` is the single caller of
// this; see its header comment for the "one seam" framing).
//
// Pre-start race (fix round 1, task-7-report.md): `start()` is async
// (`await navigator.mediaDevices.getUserMedia(...)`), and a permission
// prompt or plain negotiation latency can take anywhere from
// milliseconds to several seconds. Neither `startMs` nor
// `fallbackStartMs` is set until that settles, so `now()` would
// otherwise return a bare, misleading 0 for that whole window — silently
// mislabeling any flag/note created in it as "t=0" instead of falling
// through to `session_elapsed_seconds`. `ready` (false until either base
// is set) is the signal callers must check first; `current_t()` in
// app.svelte does exactly that.
//
// Upload contract (task-7-brief.md: "chunks every 5s accumulated; on
// session end or every 60s, upload full blob ... idempotent"): every
// `ondataavailable` chunk is kept (never dropped after a successful
// upload — only the *first* chunk carries the webm container header, so
// every upload must resend the full accumulated blob from t=0, not just
// what's new). `POST /api/session/:id/audio` overwrites the file
// wholesale each time (Task 3), so re-sending the same bytes twice is a
// harmless no-op — that's what makes the interval + stop() + best-effort
// pagehide upload paths all safe to fire redundantly.
//
// Honest limit, not silently glossed over: there is no reliable way to
// upload a multi-MB blob from a `beforeunload`/`pagehide` handler — both
// `fetch(..., {keepalive:true})` and `navigator.sendBeacon` cap payload
// size far below what even a short recording accumulates. The `pagehide`
// upload below is best-effort (fire-and-forget, may simply fail silently
// for a longer session); the 60s interval is the actual durability
// guarantee. A closed tab can lose up to the last ~60s of audio — flagged
// in the report, not hidden.

import { elapsed_excluding_paused, pick_mime_type } from './audio_helpers';

const CHUNK_MS = 5000;
const UPLOAD_INTERVAL_MS = 60000;

export interface AudioRecorderCallbacks {
  /** Fired whenever active-recording state changes — drives
   *  `SessionStore.recording` (Task 6's header-dot contract). */
  onRecordingChange: (recording: boolean) => void;
  /** Fired once, the first time the mic turns out to be unavailable or
   *  denied. `now()` keeps working via the `performance.now()` fallback
   *  either way — the app stays fully usable, per the brief. */
  onNoMic: () => void;
  /** Fired after every successful upload (including the first) so the
   *  caller can persist `session.audioFile` (`store.set_audio_file`). */
  onAudioUploaded?: () => void;
}

export interface AudioRecorderController {
  /** Requests the mic and starts recording. Never rejects — a denied/
   *  missing mic routes through `onNoMic` instead, so callers don't need
   *  a try/catch around this. */
  start(): Promise<void>;
  /** Stops recording (no-op if never started or already stopped),
   *  performs one final upload of every accumulated chunk, and releases
   *  the mic track. Awaits the final upload before resolving. */
  stop(): Promise<void>;
  /** Seconds elapsed on the active timebase — see the module header's
   *  "Timebase contract". Returns 0 before `start()` has run, or before
   *  `start()`'s async work (getUserMedia/MediaRecorder negotiation) has
   *  settled — see `ready` below; that 0 is a "no real answer yet"
   *  placeholder, not a real elapsed time, and callers must check `ready`
   *  before trusting it. v0.3 train-fixes Part B: while paused, this is
   *  frozen at whatever it read the instant `pause()` was called (see
   *  `pause()`'s doc comment) — it does NOT keep advancing during a
   *  pause, matching MediaRecorder's own paused audio stream. */
  now(): number;
  /** v0.3 train-fixes Part B: pauses the underlying `MediaRecorder` (a
   *  no-op if there is no real recorder — the no-mic fallback clock still
   *  freezes via the same `pausedAtMs` bookkeeping `now()` reads) and
   *  freezes `now()` at its current value. No-op if already paused or if
   *  no timebase has been established yet (`ready` is false). */
  pause(): void;
  /** v0.3 train-fixes Part B: resumes the underlying `MediaRecorder` (if
   *  one exists) and un-freezes `now()`, which then continues climbing
   *  from exactly where it was when `pause()` was called — the paused
   *  wall-clock interval is excluded, never counted. No-op if not
   *  currently paused. */
  resume(): void;
  /** True while paused (between a `pause()` call and the matching
   *  `resume()`). */
  readonly paused: boolean;
  /** True once a timebase has actually been established — either the
   *  real recorder clock (mic granted, `MediaRecorder.start()` called) or
   *  the no-mic fallback clock (denied/unavailable). False from
   *  construction until `start()`'s async work settles: a fresh
   *  `create_audio_recorder()` call has neither `startMs` nor
   *  `fallbackStartMs` yet, and `getUserMedia`'s permission prompt (or
   *  simple negotiation latency) can take anywhere from milliseconds to
   *  several seconds. Callers MUST check this before trusting `now()` —
   *  `now()` returns a bare 0 while `ready` is false, which is a "no
   *  timebase yet" placeholder, not a real elapsed time, and must not be
   *  used to stamp a `Flag`/`Note`'s `t` (see app.svelte's `current_t()`,
   *  which falls through to `session_elapsed_seconds` until this is
   *  true). */
  readonly ready: boolean;
  /** True once the mic has been confirmed denied/unavailable. */
  readonly noMic: boolean;
}

export function create_audio_recorder(sessionId: string, callbacks: AudioRecorderCallbacks): AudioRecorderController {
  let startMs: number | null = null;
  let fallbackStartMs: number | null = null;
  let noMic = false;
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  const chunks: Blob[] = [];
  let mimeType = '';
  let uploadTimer: ReturnType<typeof setInterval> | null = null;
  let pagehideHandler: (() => void) | null = null;
  // v0.3 train-fixes Part B — pause/resume bookkeeping. `pausedAtMs` is
  // the `performance.now()` instant `pause()` was called, non-null only
  // while currently paused; `totalPausedMs` accumulates every completed
  // pause's duration, so a session paused/resumed multiple times keeps
  // excluding ALL of that dead time, not just the most recent pause.
  let pausedAtMs: number | null = null;
  let totalPausedMs = 0;

  function mark_no_mic(): void {
    if (noMic) return;
    noMic = true;
    fallbackStartMs = performance.now();
    callbacks.onNoMic();
  }

  function build_blob(): Blob | null {
    if (chunks.length === 0) return null;
    return mimeType ? new Blob(chunks, { type: mimeType }) : new Blob(chunks);
  }

  async function upload(): Promise<void> {
    const blob = build_blob();
    if (!blob) return;
    try {
      const res = await fetch(`/api/session/${sessionId}/audio`, {
        method: 'POST',
        headers: { 'Content-Type': mimeType || 'audio/webm' },
        body: blob
      });
      if (res.ok) callbacks.onAudioUploaded?.();
    } catch (err) {
      // Best-effort: nothing is lost (chunks are never dropped on a
      // failed upload), only delayed to the next interval tick / stop().
      console.error('[talkweave] audio upload failed', err);
    }
  }

  function upload_best_effort_on_pagehide(): void {
    const blob = build_blob();
    if (!blob) return;
    void fetch(`/api/session/${sessionId}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType || 'audio/webm' },
      body: blob,
      keepalive: true
    }).catch(() => {});
  }

  async function start(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      mark_no_mic();
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      mark_no_mic();
      return;
    }

    mimeType = pick_mime_type((t) => MediaRecorder.isTypeSupported(t));
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    startMs = performance.now();

    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onerror = () => {
      callbacks.onRecordingChange(false);
      mark_no_mic();
    };

    mediaRecorder.start(CHUNK_MS);
    callbacks.onRecordingChange(true);

    uploadTimer = setInterval(() => {
      void upload();
    }, UPLOAD_INTERVAL_MS);

    pagehideHandler = () => upload_best_effort_on_pagehide();
    window.addEventListener('pagehide', pagehideHandler);
  }

  async function stop(): Promise<void> {
    if (uploadTimer !== null) {
      clearInterval(uploadTimer);
      uploadTimer = null;
    }
    if (pagehideHandler) {
      window.removeEventListener('pagehide', pagehideHandler);
      pagehideHandler = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      const mr = mediaRecorder;
      await new Promise<void>((resolve) => {
        mr.onstop = () => resolve();
        mr.stop();
      });
    }
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (startMs !== null) callbacks.onRecordingChange(false);
    await upload();
  }

  function now(): number {
    // Frozen at the pause instant while paused — see the interface's
    // `now()` doc comment and `elapsed_excluding_paused`'s own header
    // comment for why passing `pausedAtMs` here (instead of a fresh
    // `performance.now()`) is what makes the freeze work.
    const effectiveNowMs = pausedAtMs !== null ? pausedAtMs : performance.now();
    const base = startMs ?? fallbackStartMs;
    if (base === null) return 0;
    return elapsed_excluding_paused(base, effectiveNowMs, totalPausedMs);
  }

  function pause(): void {
    if (pausedAtMs !== null) return; // already paused
    if (startMs === null && fallbackStartMs === null) return; // no timebase yet
    pausedAtMs = performance.now();
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
  }

  function resume(): void {
    if (pausedAtMs === null) return; // not paused
    totalPausedMs += performance.now() - pausedAtMs;
    pausedAtMs = null;
    if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
  }

  return {
    start,
    stop,
    now,
    pause,
    resume,
    get ready() {
      return startMs !== null || fallbackStartMs !== null;
    },
    get noMic() {
      return noMic;
    },
    get paused() {
      return pausedAtMs !== null;
    }
  };
}
