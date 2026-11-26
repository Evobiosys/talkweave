#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — v0.2 live transcription headless verification (handover step
// 8: DEVLOG/v02-live-transcription_of-talkweave_handover.md). A parallel
// script to scripts/headless_verify.mjs, not folded into it — this one's
// SETUP (env vars pointing at a stub whisper binary, fake-media-device
// Chromium flags, a granted microphone permission) is different enough
// from the demo-replay flow that keeping them separate is clearer than
// branching one script two ways.
//
// Two scenarios, both real (this is not a smoke test that always passes):
//
//   1. REAL whisper-cli, if this machine happens to have it installed and
//      a model downloaded (`server/lib/whisper_stream.mjs`'s
//      `check_whisper_availability`, same real-install check the app
//      itself uses). At the time this script was written, neither
//      whisper-cli nor cmake is installed on this machine — this
//      scenario SKIPS (not fails) with a printed reason, per the
//      handover's explicit "the script must skip gracefully... printing
//      why" — it never hard-depends on a system binary that may not be
//      present.
//   2. STUB-driven pipeline proof, which ALWAYS runs regardless of (1):
//      a tiny stand-in script masquerades as `whisper-cli`
//      (`TALKWEAVE_WHISPER_BIN`) and a throwaway file stands in for the
//      model (`TALKWEAVE_WHISPER_MODEL`), so the full real pipeline runs
//      end to end — real server, real headless Chromium with
//      `--use-fake-device-for-media-stream` feeding real getUserMedia/
//      AudioContext/ScriptProcessorNode capture, real POST
//      /api/mic/audio/:id + GET /api/mic/stream/:id SSE, real
//      engine_bridge — and the one thing that actually matters gets
//      asserted: a transcript segment renders in the DOM. This is the
//      thing scenario (1) can't currently prove on this machine.
//
// The server is always killed before this process exits, success or not
// (same `kill_and_wait` as headless_verify.mjs).

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check_whisper_availability } from '../server/lib/whisper_stream.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
// `TALKWEAVE_PORT` env override, else 8990 (server.mjs's own default) —
// so this script can be run from a second checkout (a worktree building/
// testing a branch) against its OWN spawned server without colliding with
// whatever real instance is already listening on 8990.
const PORT = Number(process.env.TALKWEAVE_PORT) || 8990;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), 'Library', 'Caches', 'ms-playwright');

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same resolution strategy as headless_verify.mjs's `resolve_playwright`
 *  — see that script's header comment for why this doesn't shell out to
 *  `npx`. Kept duplicated rather than imported: these two scripts are
 *  independently runnable and this is the only piece they'd otherwise
 *  share. */
async function resolve_playwright() {
  try {
    return require('playwright');
  } catch {
    // fall through to the npx-cache scan below
  }

  const npxRoot = join(homedir(), '.npm', '_npx');
  let entries = [];
  try {
    entries = readdirSync(npxRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateRoot = join(npxRoot, entry.name, 'node_modules');
    const playwrightIndex = join(candidateRoot, 'playwright', 'index.js');
    const browsersJsonPath = join(candidateRoot, 'playwright-core', 'browsers.json');
    if (!existsSync(playwrightIndex) || !existsSync(browsersJsonPath)) continue;
    try {
      const browsers = JSON.parse(await (await import('node:fs/promises')).readFile(browsersJsonPath, 'utf-8'));
      const chromium = browsers.browsers?.find((b) => b.name === 'chromium');
      if (!chromium) continue;
      const chromiumDir = join(BROWSERS_PATH, `chromium-${chromium.revision}`);
      const headlessShellDir = join(BROWSERS_PATH, `chromium_headless_shell-${chromium.revision}`);
      if (!existsSync(chromiumDir) || !existsSync(headlessShellDir)) continue;
      return require(playwrightIndex);
    } catch {
      continue;
    }
  }

  throw new Error(
    'Could not find a usable local Playwright install with a matching downloaded Chromium build ' +
      `(looked under ${BROWSERS_PATH} — see headless_verify.mjs's header comment for the full resolution recipe).`
  );
}

/** Polls GET /api/health until it answers 200 or `timeoutMs` elapses. */
async function wait_for_server(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

/** @param {import('node:child_process').ChildProcess} child */
async function kill_and_wait(child) {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

/** Writes a tiny executable Node script standing in for `whisper-cli`:
 *  ignores its argv entirely (this adapter only ever reads stdout, never
 *  parses whisper-cli's own output beyond that) and, after a short delay
 *  (simulating real decode latency), prints a fixed sentence — enough for
 *  this script to assert a REAL transcript segment with REAL, recognizable
 *  text ends up in the DOM, not just "something rendered."
 *  @returns {Promise<{ dir: string; bin: string; model: string }>} */
async function write_stub_whisper() {
  const dir = await mkdtemp(join(tmpdir(), 'talkweave-headless-mic-stub-'));
  const bin = join(dir, 'whisper-cli-stub.mjs');
  const model = join(dir, 'ggml-stub.bin');
  await writeFile(
    bin,
    `#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write('this is a stub transcription'); }, 30);\n`
  );
  await chmod(bin, 0o755);
  await writeFile(model, Buffer.from('not a real model, just needs to exist'));
  return { dir, bin, model };
}

async function run_real_whisper_scenario() {
  console.log('[headless_verify_mic] scenario 1/2: real whisper-cli live-mic session…');
  const status = check_whisper_availability({ repoRoot: REPO_ROOT });
  if (!status.available || !status.modelPresent) {
    console.log(
      `[headless_verify_mic] SKIPPED (graceful, not a failure): whisper not ready on this machine — ` +
        `available=${status.available} (bin: ${status.bin}) modelPresent=${status.modelPresent} (model: ${status.model}). ` +
        `See README's "Live transcription (v0.2)" section to install whisper-cli and download a model, then re-run this script.`
    );
    return { skipped: true };
  }
  console.log(
    `[headless_verify_mic] whisper IS available on this machine (bin=${status.bin}, model=${status.model}) — ` +
      'a real end-to-end live-mic run against the actual binary is possible but not automated by this script ' +
      '(no reliable synthetic-speech audio source to assert specific transcribed TEXT against); ' +
      'a human should do one manual live-mic smoke test post-install instead.'
  );
  return { skipped: false };
}

async function run_stub_pipeline_scenario(playwright) {
  console.log('[headless_verify_mic] scenario 2/2: stub-driven pipeline proof (always runs)…');
  const failures = [];
  const stub = await write_stub_whisper();
  /** @type {import('node:child_process').ChildProcess | null} */
  let serverProcess = null;
  /** @type {any} */
  let browser = null;

  try {
    console.log(`[headless_verify_mic] starting server on ${BASE_URL} with a stub whisper binary…`);
    serverProcess = spawn('node', ['server/server.mjs'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TALKWEAVE_WHISPER_BIN: stub.bin,
        TALKWEAVE_WHISPER_MODEL: stub.model,
        TALKWEAVE_WHISPER_TICK_MS: '300',
        // Found while verifying the live-transcription-visibility fix:
        // `select_asr_engine` (asr_engine.mjs) prefers a REACHABLE qwen3-
        // asr proxy over this script's own injected whisper-cli stub —
        // silently correct in production (real availability wins), but
        // it defeats this script's whole point on any machine that
        // happens to have the qwen proxy running (this one), since real
        // qwen then gets fed silent fake-device audio and never produces
        // any text at all. Force whisper explicitly so the deterministic
        // stub is what actually runs, regardless of what else is
        // listening on 127.0.0.1:8001 — see asr_engine.mjs's own
        // `TALKWEAVE_ASR_ENGINE` doc comment for this exact escape hatch.
        TALKWEAVE_ASR_ENGINE: 'whisper'
      }
    });
    let serverOutput = '';
    serverProcess.stdout.on('data', (d) => (serverOutput += d.toString()));
    serverProcess.stderr.on('data', (d) => (serverOutput += d.toString()));
    serverProcess.once('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[headless_verify_mic] server exited early with code ${code}\n${serverOutput}`);
    });

    await wait_for_server();
    console.log('[headless_verify_mic] server is healthy; confirming it reports the stub whisper as available…');
    const availRes = await fetch(`${BASE_URL}/api/whisper/available`);
    const avail = await availRes.json();
    if (!avail.available || !avail.modelPresent) {
      throw new Error(`server did not report the stub whisper as available: ${JSON.stringify(avail)}`);
    }

    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      permissions: ['microphone']
    });

    // Pre-select the 'mic' engine (settings_store_core.ts's
    // SETTINGS_STORAGE_KEY) so a live session starts real transcription
    // immediately, with no settings-drawer UI interaction needed — same
    // localStorage pre-seed technique headless_verify.mjs uses for
    // replaySpeed.
    await page.addInitScript(() => {
      window.localStorage.setItem('talkweave.settings.v1', JSON.stringify({ engine: 'mic' }));
    });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });

    console.log('[headless_verify_mic] starting a live session…');
    await page.getByRole('button', { name: 'live session' }).click();

    // live-transcription-visibility fix: a fresh live session starts with
    // no speaker chosen, and — deliberately, NOT pressing ArrowLeft/Right
    // here yet, reproducing exactly what Jakob reported ("the live
    // transcription still doesn't work... I really need to see that") —
    // the stub's transcribed text must still render, unattributed, rather
    // than being silently dropped the way it used to be before
    // `EngineEvent.speaker` (shared/engine.ts) became `Speaker | null`.
    console.log('[headless_verify_mic] waiting for an UNATTRIBUTED transcript segment to render (no speaker key pressed yet)…');
    await page.waitForFunction(() => document.querySelectorAll('[data-segment-id]').length >= 1, null, {
      timeout: 30000
    });

    const segmentTexts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-segment-id]')).map((el) => el.textContent ?? '')
    );
    console.log(`[headless_verify_mic] transcript segment(s) rendered before any speaker key: ${JSON.stringify(segmentTexts)}`);

    if (!segmentTexts.some((t) => t.includes('this is a stub transcription'))) {
      failures.push(`no rendered segment contained the stub's transcribed text; got: ${JSON.stringify(segmentTexts)}`);
    }
    const unattributedAligned = await page.evaluate(() => {
      const body = document.querySelector('[data-segment-id] .segment-body');
      return body?.classList.contains('align-center') ?? false;
    });
    if (!unattributedAligned) {
      failures.push('the pre-attribution segment did not render with align-center — expected transcript_helpers.ts\'s null-speaker alignment');
    }

    // Now press ArrowLeft — the SAME still-open segment (same tStart, its
    // window not yet capped/flushed) must become attributed to 'L' in
    // place, not duplicated into a second segment.
    console.log('[headless_verify_mic] pressing ArrowLeft — the pending segment must become attributed, not duplicated…');
    const priorSegmentCount = segmentTexts.length;
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(
      () => document.querySelector('[data-segment-id] .segment-body')?.classList.contains('align-left') ?? false,
      null,
      { timeout: 15000 }
    );
    const afterAttributionCount = await page.evaluate(() => document.querySelectorAll('[data-segment-id]').length);
    if (afterAttributionCount !== priorSegmentCount) {
      failures.push(
        `expected the pending segment to be promoted in place (count unchanged at ${priorSegmentCount}), ` +
          `got ${afterAttributionCount} segments — looks duplicated rather than re-attributed`
      );
    }

    const bodyText = await page.evaluate(() => document.body.textContent ?? '');
    if (bodyText.includes('mic transcription offline')) {
      failures.push('the "mic transcription offline" chip appeared — the stub pipeline should have stayed available throughout');
    }

    // Prove speaker attribution is live and manual: switch to the right
    // speaker mid-session (ArrowRight), flush a fresh utterance through,
    // and confirm the NEXT segment is attributed 'R' — exercising
    // mic_engine.ts's notify_speaker_change -> POST /api/mic/flush path
    // for real, not just mic_engine_core.test.ts's pure simulation of it.
    console.log('[headless_verify_mic] switching speaker (ArrowRight) and waiting for a second, R-attributed segment…');
    const priorCount = segmentTexts.length;
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-segment-id]').length > n,
      priorCount,
      { timeout: 15000 }
    );
    // transcript_view.svelte renders each segment's alignment as
    // `.segment-body.align-{left|right|center}` (transcript_helpers.ts's
    // `alignment_for`: L -> left, R -> right) — the newest segment having
    // `align-right` is the DOM-level proof that `notify_speaker_change`
    // really did flow ArrowRight all the way through
    // mic_engine.ts -> POST /api/mic/flush/:id -> the server's final
    // event -> mic_engine_core.ts's turn tracker -> engine_bridge.ts.
    const newestAlignsRight = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-segment-id]'));
      return els[els.length - 1]?.querySelector('.segment-body')?.classList.contains('align-right') ?? false;
    });
    if (!newestAlignsRight) {
      failures.push('the newest segment after ArrowRight is not aligned right — speaker attribution did not switch as expected');
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best-effort
      }
    }
    if (serverProcess) {
      console.log('[headless_verify_mic] killing server…');
      await kill_and_wait(serverProcess);
    }
    await rm(stub.dir, { recursive: true, force: true }).catch(() => {});
  }

  return failures;
}

async function main() {
  const allFailures = [];

  await run_real_whisper_scenario();

  console.log('[headless_verify_mic] building app (npm run build)…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('\n[headless_verify_mic] FAILED: npm run build failed');
    process.exit(1);
  }

  console.log('[headless_verify_mic] resolving Playwright…');
  let playwright;
  try {
    playwright = await resolve_playwright();
  } catch (err) {
    console.error(`\n[headless_verify_mic] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const stubFailures = await run_stub_pipeline_scenario(playwright);
  allFailures.push(...stubFailures);

  if (allFailures.length > 0) {
    console.error('\n[headless_verify_mic] FAILED:');
    for (const f of allFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n[headless_verify_mic] all checks passed (stub-driven pipeline proof green; real-binary scenario ran or skipped gracefully as reported above).');
}

await main();
