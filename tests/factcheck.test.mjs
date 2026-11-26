// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  build_contradiction_prompt,
  build_deep_prompt,
  build_quick_prompt,
  DEEP_ETA_SEED_MS,
  default_deep_stats,
  parse_contradiction_response,
  read_deep_stats,
  record_deep_duration
} from '../server/lib/factcheck.mjs';

function seg(id, speaker, tStart, tEnd, text, final = true) {
  return { id, speaker, tStart, tEnd, text, final };
}

describe('build_quick_prompt / build_deep_prompt', () => {
  const context = [seg('s1', 'L', 0, 3, 'Vienna has about two million people.')];

  it('both include the question and the transcript', () => {
    const quick = build_quick_prompt('How many people live in Vienna?', context);
    expect(quick).toContain('How many people live in Vienna?');
    expect(quick).toContain('L: Vienna has about two million people.');

    const deep = build_deep_prompt('How many people live in Vienna?', context);
    expect(deep).toContain('How many people live in Vienna?');
    expect(deep).toContain('L: Vienna has about two million people.');
  });

  it('the quick prompt asks for brevity, the deep prompt asks for thoroughness (distinct prompts)', () => {
    const quick = build_quick_prompt('q', context);
    const deep = build_deep_prompt('q', context);
    expect(quick).not.toBe(deep);
    expect(quick.toLowerCase()).toContain('brief');
    expect(deep.toLowerCase()).toContain('thorough');
  });

  it('windows to only the most recent FACTCHECK_CONTEXT_WINDOW_SEGMENTS final segments', () => {
    const many = Array.from({ length: 25 }, (_, i) => seg(`s${i}`, 'L', i, i + 1, `line ${i}`));
    const prompt = build_quick_prompt('q', many);
    expect(prompt).not.toContain('line 0');
    expect(prompt).toContain('line 24');
  });

  it('ignores non-final (interim) segments', () => {
    const withInterim = [seg('s1', 'L', 0, 1, 'finished thought'), seg('s2', 'L', 1, 2, 'still typing...', false)];
    const prompt = build_quick_prompt('q', withInterim);
    expect(prompt).toContain('finished thought');
    expect(prompt).not.toContain('still typing...');
  });
});

describe('build_contradiction_prompt', () => {
  it('includes the question and both answers', () => {
    const prompt = build_contradiction_prompt('q', 'quick answer text', 'deep answer text');
    expect(prompt).toContain('q');
    expect(prompt).toContain('quick answer text');
    expect(prompt).toContain('deep answer text');
    expect(prompt.toLowerCase()).toContain('yes');
    expect(prompt.toLowerCase()).toContain('no');
  });
});

describe('parse_contradiction_response', () => {
  it('parses a clean "yes, <sentence>" response', () => {
    expect(parse_contradiction_response('Yes, they contradict because the dates differ.')).toEqual({
      contradicts: true,
      nuance: 'they contradict because the dates differ.'
    });
  });

  it('parses a clean "no" response with a trailing sentence', () => {
    expect(parse_contradiction_response('No, they are in full agreement.')).toEqual({
      contradicts: false,
      nuance: 'they are in full agreement.'
    });
  });

  it('accepts a bare "yes"/"no" with nothing after it', () => {
    expect(parse_contradiction_response('yes')).toEqual({ contradicts: true, nuance: '' });
    expect(parse_contradiction_response('No.')).toEqual({ contradicts: false, nuance: '' });
  });

  it('is case-insensitive and tolerates various separators', () => {
    expect(parse_contradiction_response('YES: they nuance each other.')).toEqual({
      contradicts: true,
      nuance: 'they nuance each other.'
    });
    expect(parse_contradiction_response('no - simple agreement')).toEqual({
      contradicts: false,
      nuance: 'simple agreement'
    });
  });

  it('treats garbage (no leading yes/no token) as contradicts:false with no nuance', () => {
    expect(parse_contradiction_response('asdkjfh lkjasdf')).toEqual({ contradicts: false, nuance: '' });
    expect(parse_contradiction_response('Definitely maybe!')).toEqual({ contradicts: false, nuance: '' });
  });

  it('treats an empty/whitespace-only response the same as garbage', () => {
    expect(parse_contradiction_response('')).toEqual({ contradicts: false, nuance: '' });
    expect(parse_contradiction_response('   ')).toEqual({ contradicts: false, nuance: '' });
    expect(parse_contradiction_response(undefined)).toEqual({ contradicts: false, nuance: '' });
  });
});

describe('deep stats (rolling ETA average)', () => {
  let workDir;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'talkweave-factcheck-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('default_deep_stats seeds at DEEP_ETA_SEED_MS with count 0', () => {
    expect(default_deep_stats()).toEqual({ avgMs: DEEP_ETA_SEED_MS, count: 0 });
  });

  it('read_deep_stats returns the seed when no file exists yet', async () => {
    const stats = await read_deep_stats(workDir);
    expect(stats).toEqual({ avgMs: DEEP_ETA_SEED_MS, count: 0 });
  });

  it('read_deep_stats returns the seed for malformed JSON on disk', async () => {
    await writeFile(join(workDir, '.deep_stats.json'), 'not json {{{');
    const stats = await read_deep_stats(workDir);
    expect(stats).toEqual({ avgMs: DEEP_ETA_SEED_MS, count: 0 });
  });

  it('read_deep_stats returns the seed for a validly-shaped-but-nonsensical value', async () => {
    await writeFile(join(workDir, '.deep_stats.json'), JSON.stringify({ avgMs: -5, count: 1 }));
    expect(await read_deep_stats(workDir)).toEqual({ avgMs: DEEP_ETA_SEED_MS, count: 0 });
  });

  it('the FIRST recorded completion sets avgMs to its own duration outright — the seed is never averaged in', async () => {
    const next = await record_deep_duration(workDir, 20000);
    expect(next).toEqual({ avgMs: 20000, count: 1 });

    const onDisk = JSON.parse(await readFile(join(workDir, '.deep_stats.json'), 'utf-8'));
    expect(onDisk).toEqual({ avgMs: 20000, count: 1 });
  });

  it('rolls a cumulative mean across multiple completions, persisted to disk each time', async () => {
    await record_deep_duration(workDir, 20000);
    const second = await record_deep_duration(workDir, 40000);
    expect(second).toEqual({ avgMs: 30000, count: 2 });

    const third = await record_deep_duration(workDir, 30000);
    expect(third.count).toBe(3);
    expect(third.avgMs).toBeCloseTo(30000, 5);

    const onDisk = JSON.parse(await readFile(join(workDir, '.deep_stats.json'), 'utf-8'));
    expect(onDisk).toEqual(third);
  });

  it('read_deep_stats reflects what record_deep_duration wrote, across separate calls', async () => {
    await record_deep_duration(workDir, 15000);
    const stats = await read_deep_stats(workDir);
    expect(stats).toEqual({ avgMs: 15000, count: 1 });
  });

  it('creates sessionsRoot if it does not exist yet', async () => {
    const nested = join(workDir, 'nested', 'sessions');
    const next = await record_deep_duration(nested, 12345);
    expect(next).toEqual({ avgMs: 12345, count: 1 });
  });
});
