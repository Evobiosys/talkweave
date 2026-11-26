// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  make_session_id,
  is_valid_session_id,
  create_session,
  write_session,
  read_session,
  list_sessions,
  write_audio,
  read_audio,
  resolve_sessions_root
} from '../server/lib/sessions.mjs';

let workDir;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'talkweave-sessions-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(workDir, { recursive: true, force: true });
});

describe('make_session_id / is_valid_session_id', () => {
  it('formats a fixed date as YYYYMMDD-HHMMSS', () => {
    const id = make_session_id(new Date(2026, 7, 18, 9, 5, 3)); // months are 0-indexed
    expect(id).toBe('20260818-090503');
    expect(is_valid_session_id(id)).toBe(true);
  });

  it('rejects malformed or path-traversal-shaped ids', () => {
    expect(is_valid_session_id('not-an-id')).toBe(false);
    expect(is_valid_session_id('../../etc/passwd')).toBe(false);
    expect(is_valid_session_id('20260818-09050')).toBe(false); // one digit short
    expect(is_valid_session_id('20260818-0905033')).toBe(false); // one digit long
    expect(is_valid_session_id('20260818-090503/x')).toBe(false);
  });
});

describe('create_session', () => {
  it('creates a session directory with a valid session.md', async () => {
    const { id, title, startedAt } = await create_session(workDir, { title: 'My chat' });
    expect(is_valid_session_id(id)).toBe(true);
    expect(title).toBe('My chat');
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const md = await readFile(join(workDir, id, 'session.md'), 'utf-8');
    expect(md).toContain(`# Talkweave — ${title}`);
    expect(md).toContain(`id: ${id}`);
  });

  it('defaults the title when none is given, and never an empty title', async () => {
    const { title } = await create_session(workDir);
    expect(title.length).toBeGreaterThan(0);
  });

  it('defaults names to empty strings when none is given', async () => {
    const { id } = await create_session(workDir);
    const md = await readFile(join(workDir, id, 'session.md'), 'utf-8');
    expect(md).toContain('names: L= R=');
  });

  it('allocates two distinct ids and preserves both files when two creates land in the same wall-clock second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0));

    const first = await create_session(workDir, { title: 'first' });
    const second = await create_session(workDir, { title: 'second' });

    expect(first.id).not.toBe(second.id);
    expect(is_valid_session_id(first.id)).toBe(true);
    expect(is_valid_session_id(second.id)).toBe(true);

    const firstMd = await readFile(join(workDir, first.id, 'session.md'), 'utf-8');
    const secondMd = await readFile(join(workDir, second.id, 'session.md'), 'utf-8');
    expect(firstMd).toContain('# Talkweave — first');
    expect(secondMd).toContain('# Talkweave — second');
  });
});

describe('write_session / read_session', () => {
  it('writes then reads back the exact same text', async () => {
    const { id } = await create_session(workDir);
    const md = '# Talkweave — Edited\nid: ' + id + '\nstarted: x\nnames: L=a R=b\n\n## Transcript\n\n## Summaries\n\n## Fact-checks\n';
    const ok = await write_session(workDir, id, md);
    expect(ok).toBe(true);

    const readBack = await read_session(workDir, id);
    expect(readBack).toBe(md);
  });

  it('write_session rejects an invalid id without writing anything', async () => {
    const ok = await write_session(workDir, '../../evil', 'malicious content');
    expect(ok).toBe(false);
    const entries = await readdir(workDir).catch(() => []);
    expect(entries).toEqual([]);
  });

  it('read_session returns null for an invalid id', async () => {
    expect(await read_session(workDir, 'nope')).toBeNull();
  });

  it('read_session returns null for a valid-shaped id with no session on disk', async () => {
    expect(await read_session(workDir, '20260101-000000')).toBeNull();
  });

  it('write_session creates the session directory if it does not exist yet (PUT before POST is still safe)', async () => {
    const id = '20260101-000000';
    const ok = await write_session(workDir, id, 'content');
    expect(ok).toBe(true);
    expect(await read_session(workDir, id)).toBe('content');
  });

  it('does not leave a stray .tmp- file behind after a successful write', async () => {
    const { id } = await create_session(workDir);
    await write_session(workDir, id, 'updated content');
    const entries = await readdir(join(workDir, id));
    expect(entries.every((f) => !f.includes('.tmp-'))).toBe(true);
  });
});

describe('list_sessions', () => {
  it('returns an empty array when the sessions root does not exist', async () => {
    const missingDir = join(workDir, 'does-not-exist');
    expect(await list_sessions(missingDir)).toEqual([]);
  });

  it('lists sessions newest first with titles extracted from session.md', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
    const first = await create_session(workDir, { title: 'Oldest' });
    vi.setSystemTime(new Date(2026, 0, 2, 0, 0, 0));
    const second = await create_session(workDir, { title: 'Newest' });

    const sessions = await list_sessions(workDir);
    expect(sessions).toEqual([
      { id: second.id, title: 'Newest' },
      { id: first.id, title: 'Oldest' }
    ]);
  });

  it('ignores non-session-id directories and files under the sessions root', async () => {
    const { id, title } = await create_session(workDir, { title: 'Real one' });
    await mkdir(join(workDir, 'not-a-session-id'));
    await writeFile(join(workDir, 'stray-file.txt'), 'noise');

    const sessions = await list_sessions(workDir);
    expect(sessions).toEqual([{ id, title }]);
  });

  it('falls back to the raw id as the title when session.md is missing/unparseable', async () => {
    const id = '20260101-000000';
    await mkdir(join(workDir, id));
    await writeFile(join(workDir, id, 'session.md'), 'not a valid talkweave header at all\n');

    const sessions = await list_sessions(workDir);
    expect(sessions).toEqual([{ id, title: id }]);
  });
});

describe('write_audio / read_audio', () => {
  it('writes then reads back the exact same bytes', async () => {
    const { id } = await create_session(workDir);
    const data = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // arbitrary binary content
    const ok = await write_audio(workDir, id, data);
    expect(ok).toBe(true);

    const readBack = await read_audio(workDir, id);
    expect(readBack).toEqual(data);
  });

  it('read_audio returns null when no audio file exists yet', async () => {
    const { id } = await create_session(workDir);
    expect(await read_audio(workDir, id)).toBeNull();
  });

  it('write_audio/read_audio reject an invalid id', async () => {
    expect(await write_audio(workDir, '../evil', Buffer.from([1]))).toBe(false);
    expect(await read_audio(workDir, '../evil')).toBeNull();
  });
});

describe('resolve_sessions_root', () => {
  it('defaults to <repoRoot>/sessions when TALKWEAVE_SESSIONS_DIR is unset', () => {
    expect(resolve_sessions_root(workDir, {})).toBe(join(workDir, 'sessions'));
  });

  it('defaults when TALKWEAVE_SESSIONS_DIR is present but empty/whitespace', () => {
    expect(resolve_sessions_root(workDir, { TALKWEAVE_SESSIONS_DIR: '' })).toBe(join(workDir, 'sessions'));
    expect(resolve_sessions_root(workDir, { TALKWEAVE_SESSIONS_DIR: '   ' })).toBe(join(workDir, 'sessions'));
  });

  it('uses TALKWEAVE_SESSIONS_DIR verbatim when set, ignoring repoRoot', () => {
    const override = join(workDir, 'App Support', 'TalkWeave', 'sessions');
    expect(resolve_sessions_root(workDir, { TALKWEAVE_SESSIONS_DIR: override })).toBe(override);
  });

  it('falls back to process.env when no env argument is injected', () => {
    const original = process.env.TALKWEAVE_SESSIONS_DIR;
    try {
      delete process.env.TALKWEAVE_SESSIONS_DIR;
      expect(resolve_sessions_root(workDir)).toBe(join(workDir, 'sessions'));

      process.env.TALKWEAVE_SESSIONS_DIR = join(workDir, 'override-via-real-env');
      expect(resolve_sessions_root(workDir)).toBe(join(workDir, 'override-via-real-env'));
    } finally {
      if (original === undefined) {
        delete process.env.TALKWEAVE_SESSIONS_DIR;
      } else {
        process.env.TALKWEAVE_SESSIONS_DIR = original;
      }
    }
  });
});
