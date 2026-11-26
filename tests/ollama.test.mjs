// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { ollama_generate } from '../server/lib/ollama.mjs';

/** Starts a stub http server on an ephemeral port with a custom request
 *  handler; returns its base URL and a `close()` cleanup. */
function start_stub(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

let activeStub;

afterEach(async () => {
  if (activeStub) {
    await activeStub.close();
    activeStub = null;
  }
});

describe('ollama_generate: ok (non-streaming)', () => {
  it('resolves { unavailable: false, response } from a well-formed JSON body', async () => {
    activeStub = await start_stub((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        expect(parsed).toEqual({ model: 'qwen3:4b', prompt: 'hello', stream: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'qwen3:4b', response: 'the answer', done: true }));
      });
    });

    const result = await ollama_generate({ model: 'qwen3:4b', prompt: 'hello', baseUrl: activeStub.baseUrl });
    expect(result).toEqual({ unavailable: false, response: 'the answer' });
  });
});

describe('ollama_generate: connection refused', () => {
  it('resolves { unavailable: true } when nothing is listening on the target port', async () => {
    // Port 1 is a real, always-refused port on loopback (privileged, never
    // bound by a stub server here) — a reliable "nothing there" target
    // without needing to guess an unused port number.
    const result = await ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 500
    });
    expect(result).toEqual({ unavailable: true });
  });
});

describe('ollama_generate: connect timeout', () => {
  it('resolves { unavailable: true } when the server never sends a response within timeoutMs', async () => {
    activeStub = await start_stub((_req, _res) => {
      // Never call res.end() (or even writeHead) — simulates a hung/slow
      // connection that never gets far enough to send response headers.
    });

    const start = Date.now();
    const result = await ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      baseUrl: activeStub.baseUrl,
      timeoutMs: 150
    });
    const elapsed = Date.now() - start;

    expect(result).toEqual({ unavailable: true });
    // Bounded by the injected timeout, not the default 1.5s — proves the
    // timeout parameter is actually honored rather than some longer
    // hardcoded wait.
    expect(elapsed).toBeLessThan(1000);
  });

  it('does NOT time out a slow-but-eventually-responding body once headers have arrived', async () => {
    activeStub = await start_stub((_req, res) => {
      // Headers arrive immediately (`flushHeaders` forces the header bytes
      // onto the socket right away — plain `writeHead` alone doesn't send
      // them until the first `write`/`end`, per Node's docs); the body
      // trickles in slowly, well past the small timeoutMs below — the
      // connect timeout must not apply once the `response` callback has
      // already fired.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      const payload = JSON.stringify({ response: 'slow but real' });
      setTimeout(() => res.end(payload), 400);
    });

    const result = await ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      baseUrl: activeStub.baseUrl,
      timeoutMs: 100
    });
    expect(result).toEqual({ unavailable: false, response: 'slow but real' });
  });
});

describe('ollama_generate: garbage response body', () => {
  it('resolves { unavailable: false, response: "" } for a 200 with an unparseable body', async () => {
    activeStub = await start_stub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json at all {{{');
    });

    const result = await ollama_generate({ model: 'qwen3:4b', prompt: 'hello', baseUrl: activeStub.baseUrl });
    expect(result).toEqual({ unavailable: false, response: '' });
  });

  it('resolves response: "" (not unavailable) when the JSON body has no response field', async () => {
    activeStub = await start_stub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ done: true }));
    });

    const result = await ollama_generate({ model: 'qwen3:4b', prompt: 'hello', baseUrl: activeStub.baseUrl });
    expect(result).toEqual({ unavailable: false, response: '' });
  });
});

describe('ollama_generate: abort via signal (Task 10)', () => {
  it('destroys the in-flight request and resolves { unavailable: true } when the signal aborts mid-generation', async () => {
    let handlerEntered = false;
    let sawAbortedOrClose = false;
    let markSeen;
    const seenPromise = new Promise((resolve) => {
      markSeen = resolve;
    });
    activeStub = await start_stub((req, _res) => {
      handlerEntered = true;
      // Headers are intentionally NEVER sent — this proves the abort tears
      // down the connection while the stub is still holding it open mid-
      // "generation," the exact scenario a real slow deep-model call would
      // be in when a client dismisses. `req.destroy()` on the CLIENT side
      // (ollama.mjs) surfaces here as either a `'close'` (this server's
      // req/res never got to write anything) or an `'aborted'` event —
      // Node's exact event depends on version/timing, so both are accepted.
      const mark = () => {
        sawAbortedOrClose = true;
        markSeen();
      };
      req.on('aborted', mark);
      req.on('close', mark);
    });

    const controller = new AbortController();
    const pending = ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      baseUrl: activeStub.baseUrl,
      signal: controller.signal,
      timeoutMs: 5000
    });

    // Give the request a moment to actually reach the stub server before
    // aborting, so this exercises "abort an in-flight request," not "abort
    // before the socket even connected."
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    const result = await pending;
    expect(result).toEqual({ unavailable: true });
    expect(handlerEntered).toBe(true);

    // The client (this process) can resolve `pending` the instant it calls
    // `req.destroy()`, strictly before the TCP FIN actually reaches the
    // stub server and its 'aborted'/'close' handler runs — so the
    // assertion below waits (bounded) for that event rather than checking
    // `sawAbortedOrClose` synchronously right after `pending` resolves.
    await Promise.race([seenPromise, new Promise((r) => setTimeout(r, 1000))]);
    expect(sawAbortedOrClose).toBe(true);
  });

  it('resolves { unavailable: true } immediately, without ever contacting the server, when the signal is already aborted', async () => {
    let handlerEntered = false;
    activeStub = await start_stub((_req, res) => {
      handlerEntered = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'should never be seen' }));
    });

    const controller = new AbortController();
    controller.abort();

    const result = await ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      baseUrl: activeStub.baseUrl,
      signal: controller.signal
    });

    expect(result).toEqual({ unavailable: true });
    expect(handlerEntered).toBe(false);
  });

  it('does not abort a request that completes normally before the signal ever fires', async () => {
    activeStub = await start_stub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'all good' }));
    });

    const controller = new AbortController();
    const result = await ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      baseUrl: activeStub.baseUrl,
      signal: controller.signal
    });
    expect(result).toEqual({ unavailable: false, response: 'all good' });
  });
});

describe('ollama_generate: stream mode', () => {
  it('concatenates newline-delimited JSON chunks into the full response and invokes onChunk per token', async () => {
    activeStub = await start_stub((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        expect(parsed.stream).toBe(true);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ response: 'Hello ', done: false }) + '\n');
        res.write(JSON.stringify({ response: 'world', done: false }) + '\n');
        res.write(JSON.stringify({ response: '.', done: true }) + '\n');
        res.end();
      });
    });

    const tokens = [];
    const result = await ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      stream: true,
      baseUrl: activeStub.baseUrl,
      onChunk: (t) => tokens.push(t)
    });

    expect(result).toEqual({ unavailable: false, response: 'Hello world.' });
    expect(tokens).toEqual(['Hello ', 'world', '.']);
  });

  it('skips a malformed line mid-stream without failing the whole result', async () => {
    activeStub = await start_stub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ response: 'ok ', done: false }) + '\n');
      res.write('not valid json\n');
      res.write(JSON.stringify({ response: 'still ok', done: true }) + '\n');
      res.end();
    });

    const result = await ollama_generate({
      model: 'qwen3:4b',
      prompt: 'hello',
      stream: true,
      baseUrl: activeStub.baseUrl
    });
    expect(result).toEqual({ unavailable: false, response: 'ok still ok' });
  });
});
