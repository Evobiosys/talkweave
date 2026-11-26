// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — node:http API server. Serves /api/* and, in production mode,
// the built app from app/dist. No runtime dependencies beyond Node stdlib.

import { createServer } from 'node:http';
import { join } from 'node:path';
import { handle_request } from './lib/router.mjs';
import { resolve_sessions_root } from './lib/sessions.mjs';
import { create_mic_stream_registry } from './lib/whisper_stream.mjs';
import { select_asr_engine } from './lib/asr_engine.mjs';
import { create_guard, parse_extra_origins } from './lib/origin_guard.mjs';

const HOST = '127.0.0.1';
// `TALKWEAVE_PORT` env override, else the original fixed 8990 — added so a
// second checkout (a git worktree building/testing a branch, e.g. this
// live-transcription-visibility fix) can run its OWN server instance
// without ever touching whatever real instance is already listening on
// 8990. Every production deploy still gets 8990 by simply not setting the
// var, same "env override, else the historical default" convention as
// `TALKWEAVE_WHISPER_BIN`/`TALKWEAVE_WHISPER_MODEL` (whisper_stream.mjs).
const PORT = Number(process.env.TALKWEAVE_PORT) || 8990;

const REPO_ROOT = join(import.meta.dirname, '..');
const STATIC_ROOT = join(REPO_ROOT, 'app', 'dist');
const SESSIONS_ROOT = resolve_sessions_root(REPO_ROOT);
const LANDING_ROOT = join(REPO_ROOT, 'landing');

// v0.3 (DEVLOG/qwen-asr-engine_of-talkweave_handover.md): pick the ASR
// backend ONCE at startup — qwen3-asr proxy if it actually answers, else
// whisper.cpp if its binary and model exist, else neither — see
// asr_engine.mjs's header comment for why this is a startup decision, not
// a per-request one. Top-level await is fine here: this module is only
// ever run directly (`node server/server.mjs`), never imported.
const ASR_SELECTION = await select_asr_engine({ repoRoot: REPO_ROOT });
console.log(
  `talkweave: ASR engine = ${ASR_SELECTION.engine}` +
    (ASR_SELECTION.engine === 'none' ? ' (unavailable — live transcription will refuse to start)' : ` (${ASR_SELECTION.bin})`)
);

// v0.2 live transcription: one registry for the whole server process's
// lifetime, shared across every request the same way SESSIONS_ROOT/etc
// are — see whisper_stream.mjs's header comment and router.mjs's
// `options.micRegistry` seam. `bin`/`model`/`whisperRun` come from
// whichever engine ASR_SELECTION chose; when it chose 'none' these are
// still whisper.cpp's (unusable) defaults, which is harmless — router.mjs
// refuses `/api/mic/start` before any stream that would ever call them
// gets created.
const MIC_REGISTRY = create_mic_stream_registry({
  bin: ASR_SELECTION.bin,
  model: ASR_SELECTION.model,
  whisperRun: ASR_SELECTION.whisperRun
});

// Host/Origin guard (origin_guard.mjs): runs before the router on every request.
// TALKWEAVE_EXTRA_ORIGINS optionally replaces the built-in single extra origin.
const guard = create_guard({ port: PORT, extraOrigins: parse_extra_origins(process.env.TALKWEAVE_EXTRA_ORIGINS) });

const server = createServer((req, res) => {
  if (guard(req, res)) return;
  handle_request(req, res, {
    staticRoot: STATIC_ROOT,
    sessionsRoot: SESSIONS_ROOT,
    landingRoot: LANDING_ROOT,
    repoRoot: REPO_ROOT,
    micRegistry: MIC_REGISTRY,
    whisperAvailabilityCheck: ASR_SELECTION.checkAvailability
  }).catch((err) => {
    console.error('talkweave server error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`talkweave server listening on http://${HOST}:${PORT}`);
});
