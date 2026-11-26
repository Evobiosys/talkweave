// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — client for the qwen3-asr proxy's OpenAI-compatible
// `/v1/realtime` WebSocket (see DEVLOG/live-subtitles_of-talkweave_handover.md,
// "the opportunity Task A did not take"). Same "thin client, injectable
// URL/impl, explicit timeout, never throws into the caller" shape as
// ollama.mjs, whisper_stream.mjs, and qwen_asr.mjs — this module is a
// SEPARATE adapter, not a WhisperRunFn: the realtime protocol is a
// stateful, connection-scoped conversation (append audio, get transcripts
// pushed back on the SAME socket), not a one-shot "here's a WAV, give me
// text" call.
//
// Read `~/qwen3_asr_rs/proxy.py` in full before changing anything here —
// it is short and it is the only spec; there is no separately published
// realtime protocol doc this proxy fully implements, just that file's own
// `_handle_realtime_ws`.
//
// Why this is NOT the first-word path (live-subtitles handover, item 2:
// "whatever the transport, measure and reduce time to first partial"):
//   1. The proxy pre-transcribes in `MAX_CHUNK_SECONDS = 28`-second
//      chunks — a hardcoded Python module constant. `session.update` and
//      every other message type this protocol defines are silently
//      accepted and ignored (`_handle_realtime_ws`'s own comment says so);
//      there is no way to ask for a shorter chunk from the client side.
//   2. The one way to get a transcript sooner is `input_audio_buffer.
//      commit` — but the proxy's request loop ends with a bare `break`
//      right after answering a commit, killing the TCP connection outright
//      (confirmed against the live proxy: `committed` then `completed`
//      arrive, then the socket dies with no clean WS closing handshake,
//      an `error` event followed by `close` code 1006 — see
//      `create_realtime_asr_client`'s `commitSent`-gated `onDisconnect`
//      below). A commit is a one-shot "give me what you have and end the
//      session," not a repeatable "give me a partial and keep going" — so
//      chasing a fast first word here would mean a fresh WS handshake per
//      partial, which is exactly the reconnect-and-resend cost this
//      transport exists to avoid paying on a POST-per-tick loop.
//   3. Even granting (1)/(2), this app's OWN windowing already forecloses
//      the benefit the proxy's header comment advertises ("pre-transcribes
//      … WHILE recording is still running, dramatically reducing perceived
//      latency on LONG recordings"): whisper_stream.mjs's `windowCapMs`
//      safety valve force-flushes a window at 20s, strictly BEFORE the
//      proxy's own 28s auto-chunk boundary would ever fire. Under this
//      app's current windowing, the realtime channel's own background
//      pre-chunking would never trigger within one still-open window.
// `whisper_stream.mjs`'s tick loop (with its `firstWindowMs` fast first
// tick) stays the one path that actually serves "words on screen while
// still speaking," for every turn, not just the first. This module exists
// so that fact rests on tested code, not a paragraph of prose: a real
// caller CAN open a realtime session, feed it audio, and receive
// pre-transcribed chunks — it is just not wired into the live mic
// pipeline, for the structural reasons above (see this task's result
// report for the honest accounting).
//
// Sample rate: the proxy hardcodes `SAMPLE_RATE = 24_000` for whatever
// PCM16 it receives on this socket (`RealtimeTranscriptionService`'s own
// format, per `_handle_realtime_ws`'s comment) — but every OTHER PCM path
// in this codebase (pcm_helpers.ts, wav.mjs, whisper_stream.mjs) is
// 16kHz, and there is no message in this protocol to declare a different
// input rate. Sending 16kHz bytes unresampled would have the proxy wrap
// them in a WAV header that CLAIMS 24kHz — 1.5x fast and pitch-shifted,
// silently wrong rather than a clean failure. `resample_pcm16` (linear
// interpolation — same technique, and the same "adequate for speech, not
// hi-fi" tradeoff, as pcm_helpers.ts's `downsample_to_16k`) fixes this
// before `append()` ever sends anything.
//
// Uses the global `WebSocket` (Node 22+ stdlib, backed by undici — no
// runtime dependency added) rather than a `ws`-package client, matching
// this project's "no new runtime dependencies" constraint exactly the way
// qwen_asr.mjs leans on global `fetch`/`FormData` instead of a library.

const DEFAULT_REALTIME_URL = 'ws://127.0.0.1:8001/v1/realtime';
export const DEFAULT_REALTIME_CONNECT_TIMEOUT_MS = 3000;
// What the proxy hardcodes for anything arriving on this socket (see
// module header) vs. what this codebase actually captures/buffers at
// (wav.mjs's WAV_SAMPLE_RATE, pcm_helpers.ts's TARGET_SAMPLE_RATE).
export const REALTIME_SAMPLE_RATE = 24000;
export const SOURCE_SAMPLE_RATE = 16000;
// Standard `WebSocket.readyState` values (RFC 6455 / the DOM WebSocket
// spec) — named here rather than sprinkled as magic numbers, since this
// module can't rely on `WebSocketImpl.OPEN` existing on an injected test
// double that only implements the instance surface.
const WS_OPEN = 1;

/**
 * `ASR_REALTIME_URL` env override, else `ws://127.0.0.1:8001/v1/realtime`
 * (the same proxy `qwen_asr.mjs` talks to over plain HTTP, same host/port,
 * `ws://` scheme and the proxy's own `/v1/realtime` path).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolve_realtime_url(env = process.env) {
  const raw = env.ASR_REALTIME_URL;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_REALTIME_URL;
}

/**
 * Resamples little-endian PCM16 mono audio from `fromRate` to `toRate` via
 * linear interpolation — generalizes pcm_helpers.ts's `downsample_to_16k`
 * (which only ever goes DOWN to a fixed 16kHz target) to an arbitrary
 * ratio in either direction, since this module needs to go UP, to the
 * proxy's fixed 24kHz. Returns `pcmBytes` unchanged (same reference) when
 * the rates already match or either rate is non-finite/non-positive —
 * the common "nothing to do" case never allocates.
 * @param {Buffer} pcmBytes
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Buffer}
 */
export function resample_pcm16(pcmBytes, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) return pcmBytes;
  if (fromRate === toRate) return pcmBytes;

  const inSamples = pcmBytes.length >> 1; // 2 bytes/sample, any trailing odd byte is dropped
  if (inSamples === 0) return Buffer.alloc(0);

  const ratio = fromRate / toRate;
  const outSamples = Math.max(0, Math.floor(inSamples / ratio));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, inSamples - 1);
    const frac = srcIndex - srcFloor;
    const a = pcmBytes.readInt16LE(srcFloor * 2);
    const b = pcmBytes.readInt16LE(srcCeil * 2);
    out.writeInt16LE(Math.round(a * (1 - frac) + b * frac), i * 2);
  }
  return out;
}

/**
 * `resample_pcm16` fixed at this codebase's one source rate (16kHz) and
 * the proxy's one hardcoded target (24kHz) — the only direction this
 * module's `append()` ever actually needs; exported separately mainly so
 * a test can assert the fixed 16k->24k case by name without repeating the
 * rate literals.
 * @param {Buffer} pcm16kBytes
 * @returns {Buffer}
 */
export function upsample_16k_to_24k(pcm16kBytes) {
  return resample_pcm16(pcm16kBytes, SOURCE_SAMPLE_RATE, REALTIME_SAMPLE_RATE);
}

/**
 * @typedef {{ itemId: string; transcript: string }} RealtimeCompleted
 * @typedef {{ itemId: string }} RealtimeCommitted
 */

/**
 * Creates one realtime-proxy session, unconnected. Every failure mode —
 * connect timeout, the endpoint being absent/refused, a malformed frame,
 * a mid-stream disconnect — resolves or calls back rather than
 * rejecting/throwing, the same "a tick loop must never die on a bad
 * network day" contract every other adapter in this codebase already
 * honors.
 * @param {{
 *   url?: string;
 *   WebSocketImpl?: typeof WebSocket;
 *   connectTimeoutMs?: number;
 *   onCompleted?: (event: RealtimeCompleted) => void;
 *   onCommitted?: (event: RealtimeCommitted) => void;
 *   onDisconnect?: (event: { expected: boolean }) => void;
 * }} [options]
 */
export function create_realtime_asr_client(options = {}) {
  const url = options.url ?? resolve_realtime_url();
  const WebSocketImpl = options.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_REALTIME_CONNECT_TIMEOUT_MS;

  /** @type {WebSocket | null} */
  let socket = null;
  // Set the instant `commit()` is called — the proxy's own reply-then-
  // `break` behavior (module header, point 2) means the close that
  // follows a commit is the SESSION FINISHING NORMALLY, not a dropped
  // connection; `onDisconnect`'s `expected` flag distinguishes the two so
  // a caller doesn't have to re-derive proxy internals to know whether to
  // treat a close as "done" or "broke."
  let commitSent = false;
  // Set by our OWN `close()` so the resulting `close` event (which fires
  // asynchronously, same as any WebSocket) is recognized as deliberate and
  // never reaches `onDisconnect` at all — mirrors mic_engine.ts's
  // `stopped` guard around its own `consume_sse` abort.
  let deliberatelyClosed = false;
  let disconnectReported = false;

  function safe_close() {
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closing/closed — nothing more to do.
    }
  }

  /** @param {unknown} raw */
  function handle_message(raw) {
    let msg;
    try {
      msg = JSON.parse(/** @type {string} */ (raw));
    } catch {
      return; // one malformed frame never kills the session
    }
    if (!msg || typeof msg !== 'object') return;
    const type = /** @type {Record<string, unknown>} */ (msg).type;
    if (type === 'input_audio_buffer.committed') {
      const itemId = /** @type {Record<string, unknown>} */ (msg).item_id;
      options.onCommitted?.({ itemId: typeof itemId === 'string' ? itemId : '' });
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = /** @type {Record<string, unknown>} */ (msg).item_id;
      const transcript = /** @type {Record<string, unknown>} */ (msg).transcript;
      options.onCompleted?.({
        itemId: typeof itemId === 'string' ? itemId : '',
        transcript: typeof transcript === 'string' ? transcript : ''
      });
    }
    // Any other/unknown type: silently accepted, matching the proxy's own
    // documented "session.update and unknown types are silently accepted"
    // contract on its side of this same protocol.
  }

  function report_disconnect() {
    if (deliberatelyClosed || disconnectReported) return;
    disconnectReported = true;
    options.onDisconnect?.({ expected: commitSent });
  }

  /**
   * Opens the socket. Resolves `true` once open, `false` on a connect
   * timeout, a construction error (malformed `url`), or an error/close
   * before ever opening — this is the one call site that can observe
   * "the endpoint is absent"; everything after a successful `open`
   * reports through `onCompleted`/`onCommitted`/`onDisconnect` instead.
   * @returns {Promise<boolean>}
   */
  function connect() {
    return new Promise((resolve) => {
      if (!WebSocketImpl) {
        resolve(false);
        return;
      }

      let settled = false;
      // Declared (not yet assigned) before `finish` can possibly run: a
      // `WebSocketImpl` constructor that throws synchronously calls
      // `finish(false)` before the `setTimeout` call below ever executes,
      // and `finish` closes over this binding — `let` (not `const`, and
      // pre-declared) so that early call reads `undefined` rather than
      // hitting the temporal-dead-zone `ReferenceError` a `const`
      // declared after this point would throw.
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let watchdog;
      /** @param {boolean} ok */
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve(ok);
      };

      /** @type {WebSocket} */
      let ws;
      try {
        ws = new WebSocketImpl(url);
      } catch {
        finish(false);
        return;
      }
      socket = ws;

      watchdog = setTimeout(() => {
        finish(false);
        safe_close();
      }, connectTimeoutMs);

      ws.addEventListener('open', () => finish(true));
      ws.addEventListener('message', (ev) => handle_message(/** @type {{ data: unknown }} */ (ev).data));
      // A WebSocket always fires `close` after `error` (never error alone)
      // — `error` here only needs to unstick a `connect()` still pending;
      // `close` below is the single place `onDisconnect` fires from.
      ws.addEventListener('error', () => finish(false));
      ws.addEventListener('close', () => {
        finish(false);
        report_disconnect();
      });
    });
  }

  /**
   * Sends one chunk of already-16kHz mono PCM16 audio (this codebase's one
   * fixed capture format everywhere else — see pcm_helpers.ts), resampled
   * to the proxy's hardcoded 24kHz before it goes out. No-op if the socket
   * isn't open (a late append racing a disconnect, or a caller that never
   * awaited `connect()`); never throws.
   * @param {Buffer} pcm16kBytes
   */
  function append(pcm16kBytes) {
    if (!socket || socket.readyState !== WS_OPEN) return;
    const resampled = upsample_16k_to_24k(pcm16kBytes);
    try {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: resampled.toString('base64') }));
    } catch {
      // send() throwing means the socket is already on its way down —
      // `onDisconnect` will fire (or already has) for that; nothing more
      // to do here.
    }
  }

  /**
   * Forces the buffered tail to transcribe now. Per this module's header
   * comment, the proxy answers `committed` then `completed` and then
   * closes the connection unilaterally — marking `commitSent` here is
   * what tells the `close` handler above that the closure that follows is
   * expected, not a dropped connection.
   */
  function commit() {
    if (!socket || socket.readyState !== WS_OPEN) return;
    commitSent = true;
    try {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch {
      // Already closing — there is no session left to commit.
    }
  }

  /** Deliberate, caller-initiated close — suppresses `onDisconnect` for
   *  the `close` event this itself causes (see `deliberatelyClosed`'s doc
   *  comment above). Safe to call more than once, or before `connect()`
   *  ever resolved. */
  function close() {
    deliberatelyClosed = true;
    safe_close();
  }

  return { connect, append, commit, close };
}

/**
 * Convenience probe: opens a realtime session and immediately closes it,
 * reporting only whether the endpoint accepted the connection at all.
 * Built ON `create_realtime_asr_client` (not a separate raw-socket check)
 * so "is the realtime endpoint reachable" and "can I actually talk to it"
 * are exercised by the exact same connect path, never two code paths that
 * could quietly drift apart.
 * @param {{ url?: string; WebSocketImpl?: typeof WebSocket; connectTimeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function check_realtime_availability(options = {}) {
  const client = create_realtime_asr_client(options);
  const reachable = await client.connect();
  if (reachable) client.close();
  return reachable;
}
