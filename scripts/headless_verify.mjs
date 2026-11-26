#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — task-11-brief.md's headless demo verification.
//
// Builds the app, starts the real production server (node server/server.mjs)
// on 8990, drives a real browser (headless Chromium via Playwright) through
// the demo-conversation flow at 8x replay speed, creates two flags via the
// real keyboard shortcuts, waits for both the sidebar and the transcript to
// reflect that, screenshots the result to docs/verify/demo.png, and checks
// the export endpoint renders one of the flagged segments highlighted.
// The server is always killed before this process exits, success or not.
//
// Playwright resolution: this repo's devDependency allowlist
// (global-constraints.md) does not include playwright, and task-11-brief.md
// explicitly allows falling back to a local/global/npx-cached install
// ("playwright imported from a global install if present else instruct —
// acceptable to use npx playwright@1.x with skip-download env"). Rather
// than shelling out to `npx` (which needs network access to resolve a
// registry version even with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — that env
// var only skips the *browser binary* download, not npm's own package
// resolution), `resolve_playwright` below requires an already-installed
// `playwright` package by absolute file path — no NODE_PATH juggling, no
// network call, and no assumption about *which* npx cache hash happens to
// exist on this machine. It tries, in order: (1) plain `require('playwright')`
// (a real devDependency, or NODE_PATH set by the caller), then (2) any
// `~/.npm/_npx/*/node_modules/playwright` whose bundled playwright-core
// browsers.json chromium revision has already been downloaded under
// PLAYWRIGHT_BROWSERS_PATH (default `~/Library/Caches/ms-playwright`, per
// this project's CLAUDE.md-documented convention of reusing the cached
// Playwright browsers rather than re-fetching them).

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PORT = 8990;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOT_PATH = join(REPO_ROOT, 'docs', 'verify', 'demo.png');
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), 'Library', 'Caches', 'ms-playwright');

/** Mirrors server/lib/export.mjs's `esc_html` — used only to predict what
 *  a raw DOM string looks like once export.mjs has HTML-escaped it, so
 *  this script can check for its exact presence in the exported HTML
 *  (transcript text often contains apostrophes, which `esc_html` turns
 *  into `&#39;`). @param {string} s @returns {string} */
function esc_html_like(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** @returns {Promise<any>} the `playwright` module's exports. */
async function resolve_playwright() {
  try {
    return require('playwright');
  } catch {
    // fall through to the npx-cache scan below
  }

  const npxRoot = join(homedir(), '.npm', '_npx');
  let entries = [];
  try {
    entries = await readdir(npxRoot, { withFileTypes: true });
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
      const browsers = JSON.parse(await readFile(browsersJsonPath, 'utf-8'));
      const chromium = browsers.browsers?.find((b) => b.name === 'chromium');
      if (!chromium) continue;
      // `chromium.launch({ headless: true })` (used below) actually runs the
      // *headless shell* build, not the plain `chromium-<rev>` one — a
      // candidate missing that directory launches fine on paper but throws
      // "Executable doesn't exist at .../chromium_headless_shell-<rev>/..."
      // the moment `chromium.launch` is called (hit exactly this against a
      // mismatched 1.61.1 install while writing this script). Require both.
      const chromiumDir = join(BROWSERS_PATH, `chromium-${chromium.revision}`);
      const headlessShellDir = join(BROWSERS_PATH, `chromium_headless_shell-${chromium.revision}`);
      if (!existsSync(chromiumDir) || !existsSync(headlessShellDir)) continue; // build not downloaded

      return require(playwrightIndex);
    } catch {
      continue;
    }
  }

  throw new Error(
    'Could not find a usable local Playwright install with a matching downloaded Chromium build.\n' +
      `Looked for a real devDependency/NODE_PATH-visible 'playwright', then scanned ${npxRoot}/*/node_modules/playwright\n` +
      `against downloaded browsers under ${BROWSERS_PATH}.\n` +
      "Fix: run `npx --yes -p playwright@1.62 node -e \"require('playwright')\"` once (installs the npm package into the\n" +
      `npx cache), and ensure a matching Chromium build exists under ${BROWSERS_PATH} (\`npx playwright install chromium\`).`
  );
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Kills a child process and waits for it to actually exit (SIGTERM, then
 * SIGKILL after a grace period) — "no stray servers left behind" is a
 * hard requirement for this script (task-11-brief.md's verify step: "then
 * KILLS the server").
 * @param {import('node:child_process').ChildProcess} child
 */
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

async function main() {
  const failures = [];
  /** @type {import('node:child_process').ChildProcess | null} */
  let serverProcess = null;
  /** @type {any} */
  let browser = null;

  try {
    console.log('[headless_verify] building app (npm run build)…');
    const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error(`npm run build failed with exit code ${build.status}`);

    console.log('[headless_verify] resolving Playwright…');
    const playwright = await resolve_playwright();

    console.log(`[headless_verify] starting server on ${BASE_URL}…`);
    serverProcess = spawn('node', ['server/server.mjs'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverOutput = '';
    serverProcess.stdout.on('data', (d) => (serverOutput += d.toString()));
    serverProcess.stderr.on('data', (d) => (serverOutput += d.toString()));
    serverProcess.once('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[headless_verify] server exited early with code ${code}\n${serverOutput}`);
    });

    await wait_for_server();
    console.log('[headless_verify] server is healthy.');

    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // Pre-seed localStorage so the demo replay runs at 8x from the very
    // first tick (settings_store_core.ts's SETTINGS_STORAGE_KEY,
    // merge_settings fills in every other field's default) — see
    // app/src/lib/settings_drawer.svelte's "replay speed (0.5-8x)" field.
    await page.addInitScript(() => {
      window.localStorage.setItem('talkweave.settings.v1', JSON.stringify({ replaySpeed: 8 }));
    });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });

    console.log('[headless_verify] starting demo conversation…');
    await page.getByRole('button', { name: 'demo conversation' }).click();

    // Wait for at least 3 segments so the first two turns (L, then R) are
    // both guaranteed final — engine_bridge.ts opens/updates one segment
    // per turn and play_all() awaits each turn fully before starting the
    // next, so a 3rd segment existing means turns 1 and 2 already finished.
    await page.waitForFunction(() => document.querySelectorAll('[data-segment-id]').length >= 3, null, {
      timeout: 30000
    });

    console.log('[headless_verify] creating 2 flags via ShiftLeft/ShiftRight…');
    await page.keyboard.press('ShiftLeft');
    await sleep(50);
    await page.keyboard.press('ShiftRight');

    await page.waitForFunction(() => document.querySelectorAll('.entry').length >= 2, null, { timeout: 10000 });
    console.log('[headless_verify] sidebar has >= 2 entries.');

    await page.waitForFunction(() => document.querySelectorAll('[data-segment-id]').length >= 10, null, {
      timeout: 60000
    });
    const segmentCount = await page.evaluate(() => document.querySelectorAll('[data-segment-id]').length);
    console.log(`[headless_verify] transcript has ${segmentCount} segments.`);

    await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH });
    console.log(`[headless_verify] screenshot saved to ${SCREENSHOT_PATH}`);

    const entryCount = await page.evaluate(() => document.querySelectorAll('.entry').length);
    if (entryCount < 2) failures.push(`expected >= 2 sidebar entries, got ${entryCount}`);
    if (segmentCount < 10) failures.push(`expected >= 10 segments, got ${segmentCount}`);

    // Task 11's "share" button: `,` pins the top bar visible (it's `inert`
    // otherwise — app.svelte's `topBarVisible`/`pinned` — so the button is
    // unclickable until then), then the click's fetch+blob+`<a download>`
    // path (app.svelte's `share_session`) should surface as a real
    // Playwright `download` event, same as a user-driven download would.
    console.log('[headless_verify] verifying the share button downloads the export…');
    try {
      await page.keyboard.press(',');
      const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
      await page.getByRole('button', { name: 'share' }).click();
      const download = await downloadPromise;
      const suggested = download.suggestedFilename();
      if (!suggested.endsWith('.html')) failures.push(`share button download had an unexpected filename: ${suggested}`);
      await download.delete().catch(() => {});
    } catch (err) {
      failures.push(`share button did not trigger a download: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await page.keyboard.press(','); // unpin again, tidy state before the next checks
    }

    // Per-segment, the actually-highlighted (amber) substring — not the
    // whole segment's text, since Task 9's AI-claim pipeline (or its
    // no-Ollama sentence_fallback) commonly narrows a plain-key flag down
    // to one sentence within a multi-sentence segment, same as the live
    // app's transcript_helpers.ts `highlighted_ranges` renders client-side.
    // Reconstructed the same way transcript_view.svelte builds the
    // segment's markup: each word is its own span, joined by a single
    // literal space, so the contiguous run of `.flagged-word` spans'
    // textContent joined by ' ' reproduces the highlighted substring.
    // Re-read on every export poll below (not snapshotted once here): the
    // claim pipeline patches a flag's span asynchronously
    // (handle_flag_created_for_ai -> update_flag_claim), so the
    // highlighted substring can still be moving after the flag first
    // appears in the sidebar.
    const read_flagged_texts = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.segment.flagged')).map((seg) =>
          Array.from(seg.querySelectorAll('.flagged-word'))
            .map((el) => el.textContent ?? '')
            .join(' ')
        )
      );
    const initialFlaggedTexts = await read_flagged_texts();
    if (initialFlaggedTexts.length === 0) failures.push('no segment ended up with class "flagged" after creating 2 flags');

    // Final review fix, Minor 3: the debug `.session-meta` paragraph (id +
    // dirty counter, rendered in the visible center column) was removed
    // from production UI — the session id now lives in a `data-session-id`
    // attribute on `.shell` instead, which this reads the same way.
    const sessionId = await page.evaluate(() => document.querySelector('.shell')?.getAttribute('data-session-id') ?? '');
    if (!sessionId) {
      failures.push(`could not read session id from .shell[data-session-id]`);
    } else {
      console.log(`[headless_verify] checking export endpoint for session ${sessionId}…`);

      // The session store's autosave is debounced (autosave.ts) and, while
      // the demo replay keeps notifying continuously, only fires on its
      // 10s MAX_WAIT_MS ceiling rather than the shorter settle-debounce —
      // so the flags just created via the keyboard may not have hit
      // session.md on disk yet. Poll the export endpoint rather than
      // asserting on the first response.
      const EXPORT_POLL_TIMEOUT_MS = 20000;
      const deadline = Date.now() + EXPORT_POLL_TIMEOUT_MS;
      let html = '';
      let lastStatus = 0;
      let hasMark = false;
      let hasFlaggedText = false;
      while (Date.now() < deadline) {
        const exportRes = await fetch(`${BASE_URL}/api/session/${sessionId}/export`);
        lastStatus = exportRes.status;
        if (exportRes.ok) {
          html = await exportRes.text();
          const flaggedTexts = await read_flagged_texts();
          hasMark = html.includes('class="flag-mark"');
          hasFlaggedText = flaggedTexts.some((t) => t.trim() && html.includes(esc_html_like(t.trim())));
          if (hasMark && hasFlaggedText) break;
        }
        await sleep(500);
      }

      if (lastStatus !== 200) failures.push(`export endpoint returned ${lastStatus}`);
      if (!hasMark) failures.push('export HTML has no flag-mark highlight at all (autosave may not have persisted the flags in time)');
      if (!hasFlaggedText) failures.push('export HTML does not contain any of the flagged segments’ text');
      if (html && !html.includes('<!doctype html>')) failures.push('export HTML is missing a doctype (not a full document)');
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
      console.log('[headless_verify] killing server…');
      await kill_and_wait(serverProcess);
    }
  }

  if (failures.length > 0) {
    console.error('\n[headless_verify] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n[headless_verify] all checks passed.');
}

await main();
