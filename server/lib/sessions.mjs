// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — session persistence: markdown files under sessions/<id>/session.md,
// audio sidecar under sessions/<id>/audio.webm. This module treats session
// bodies as opaque text — no markdown parsing happens here (that lives in
// shared/session_md.ts, TS, imported client-side); server/*.mjs can't
// import TS directly, so `build_initial_markdown` below hand-rolls the same
// empty-session shape session_md.ts's serializer produces (verified by a
// round-trip test against shared/session_md.ts — see
// tests/session_initial_markdown.test.ts).
//
// Every write to session.md/audio.webm is atomic: write to a sibling tmp
// file, then rename over the target, so a crash mid-write never corrupts
// the store (rename is atomic on the same filesystem).

import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Session ids are `YYYYMMDD-HHMMSS`. This regex also doubles as the
 *  path-traversal guard for every function below that takes an `id` —
 *  only digits and one dash can ever reach a filesystem path. */
export const SESSION_ID_RE = /^[0-9]{8}-[0-9]{6}$/;

const SESSION_FILE = 'session.md';
const AUDIO_FILE = 'audio.webm';
const MAX_CREATE_ATTEMPTS = 5;

/**
 * @param {number} n
 * @param {number} [len]
 * @returns {string}
 */
function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/**
 * @param {Date} [date]
 * @returns {string}
 */
export function make_session_id(date = new Date()) {
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const se = pad(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${se}`;
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function is_valid_session_id(id) {
  return SESSION_ID_RE.test(id);
}

/**
 * @param {string} sessionsRoot
 * @param {string} id
 * @returns {string}
 */
function session_dir(sessionsRoot, id) {
  return join(sessionsRoot, id);
}

/**
 * Resolves the sessions root directory: `TALKWEAVE_SESSIONS_DIR` overrides
 * the default (`<repoRoot>/sessions`) when set to a non-empty string —
 * used by the Tauri desktop shell to point sessions at the macOS App
 * Support dir instead of the repo checkout. `env` is injected (defaults to
 * `process.env`) so tests can supply a fake env object instead of mutating
 * global state.
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolve_sessions_root(repoRoot, env = process.env) {
  const override = env.TALKWEAVE_SESSIONS_DIR;
  if (typeof override === 'string' && override.trim() !== '') {
    return override;
  }
  return join(repoRoot, 'sessions');
}

/**
 * Atomically writes `contents` to `filePath`: write to a sibling tmp file,
 * then rename over the target.
 * @param {string} filePath
 * @param {string | Buffer} contents
 */
async function atomic_write(filePath, contents) {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, contents);
  await rename(tmpPath, filePath);
}

/**
 * Sentinel used to escape literal newlines inside free-text header fields
 * (title, names) — must stay byte-identical to
 * shared/session_md.ts's NEWLINE_ESCAPE, since that module's parse_session
 * is what reads these files back. Duplicated here (not imported) because
 * server/*.mjs can't import shared/*.ts directly; the fix-round-1 review
 * finding that caught the original missing-escape bug is why this constant
 * and esc() exist as their own documented unit rather than being inlined.
 * @type {string}
 */
const NEWLINE_ESCAPE = '␤';

/**
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return s.split('\n').join(NEWLINE_ESCAPE);
}

/**
 * Builds the minimal valid session.md contents for a brand-new session —
 * the same header-plus-empty-sections shape shared/session_md.ts's
 * serialize_session produces for a Session with empty arrays, so it
 * round-trips through parse_session unchanged (see
 * tests/session_initial_markdown.test.ts, the contract test between this
 * function and that module — extended to cover embedded-newline
 * title/names after fix round 1 caught this function emitting them
 * unescaped).
 * @param {{ id: string; startedAt: string; title: string; names: { L: string; R: string } }} fields
 * @returns {string}
 */
export function build_initial_markdown({ id, startedAt, title, names }) {
  return (
    [
      `# Talkweave — ${esc(title)}`,
      `id: ${id}`,
      `started: ${startedAt}`,
      `names: L=${esc(names.L)} R=${esc(names.R)}`,
      '',
      '## Transcript',
      '',
      '## Summaries',
      '',
      '## Fact-checks'
    ].join('\n') + '\n'
  );
}

/**
 * Creates a new session directory + initial session.md, returning the
 * allocated id. Ids are second-granularity (`YYYYMMDD-HHMMSS`, fixed by
 * the format spec), so two creates within the same wall-clock second are a
 * real possibility (double-click, second tab, fast reload); `mkdir` on the
 * exact id directory is deliberately non-recursive so a collision throws
 * `EEXIST` instead of silently reusing (and later clobbering) an existing
 * session, and the id is bumped a second and retried, bounded, rather than
 * either colliding or looping forever.
 * @param {string} sessionsRoot
 * @param {{ title?: string; names?: { L: string; R: string } }} [opts]
 * @returns {Promise<{ id: string; title: string; startedAt: string }>}
 */
export async function create_session(sessionsRoot, opts = {}) {
  const startedAt = new Date().toISOString();
  const title = (opts.title ?? '').trim() || 'Untitled conversation';
  const names = opts.names ?? { L: '', R: '' };

  await mkdir(sessionsRoot, { recursive: true });

  let attemptDate = new Date();
  let id = '';
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const candidateId = make_session_id(attemptDate);
    try {
      await mkdir(session_dir(sessionsRoot, candidateId));
      id = candidateId;
      break;
    } catch (/** @type {unknown} */ err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
        attemptDate = new Date(attemptDate.getTime() + 1000);
        continue;
      }
      throw err;
    }
  }
  if (!id) {
    throw new Error(`create_session: exhausted ${MAX_CREATE_ATTEMPTS} attempts to allocate a unique session id`);
  }

  const md = build_initial_markdown({ id, startedAt, title, names });
  await atomic_write(join(session_dir(sessionsRoot, id), SESSION_FILE), md);
  return { id, title, startedAt };
}

/**
 * @param {string} sessionsRoot
 * @param {string} id
 * @param {string} md
 * @returns {Promise<boolean>} false when id is invalid (caller should 400)
 */
export async function write_session(sessionsRoot, id, md) {
  if (!is_valid_session_id(id)) return false;
  const dir = session_dir(sessionsRoot, id);
  await mkdir(dir, { recursive: true });
  await atomic_write(join(dir, SESSION_FILE), md);
  return true;
}

/**
 * @param {string} sessionsRoot
 * @param {string} id
 * @returns {Promise<string | null>} null when id is invalid or the file is missing
 */
export async function read_session(sessionsRoot, id) {
  if (!is_valid_session_id(id)) return null;
  try {
    return await readFile(join(session_dir(sessionsRoot, id), SESSION_FILE), 'utf-8');
  } catch {
    return null;
  }
}

const TITLE_LINE_RE = /^#\s+Talkweave\s+[-–—]\s*(.*)$/;

/**
 * @param {string | null} md
 * @returns {string | null}
 */
function extract_title(md) {
  if (md === null) return null;
  const firstLine = (md.split(/\r\n|\r|\n/, 1)[0] ?? '').trim();
  const m = TITLE_LINE_RE.exec(firstLine);
  if (!m) return null;
  return m[1].trim() || null;
}

/**
 * Lists all sessions under sessionsRoot, newest first (ids sort
 * lexicographically = chronologically since they're zero-padded and fixed
 * width). Title is read from each session.md's first line; falls back to
 * the raw id when the file is missing or unparseable.
 * @param {string} sessionsRoot
 * @returns {Promise<{ id: string; title: string }[]>}
 */
export async function list_sessions(sessionsRoot) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = entries
    .filter((e) => e.isDirectory() && is_valid_session_id(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();

  const out = [];
  for (const id of ids) {
    const md = await read_session(sessionsRoot, id);
    out.push({ id, title: extract_title(md) ?? id });
  }
  return out;
}

/**
 * @param {string} sessionsRoot
 * @param {string} id
 * @param {Buffer} data
 * @returns {Promise<boolean>} false when id is invalid (caller should 400)
 */
export async function write_audio(sessionsRoot, id, data) {
  if (!is_valid_session_id(id)) return false;
  const dir = session_dir(sessionsRoot, id);
  await mkdir(dir, { recursive: true });
  await atomic_write(join(dir, AUDIO_FILE), data);
  return true;
}

/**
 * @param {string} sessionsRoot
 * @param {string} id
 * @returns {Promise<Buffer | null>} null when id is invalid or the file is missing
 */
export async function read_audio(sessionsRoot, id) {
  if (!is_valid_session_id(id)) return null;
  try {
    return await readFile(join(session_dir(sessionsRoot, id), AUDIO_FILE));
  } catch {
    return null;
  }
}
