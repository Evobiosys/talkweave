// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — static file serving for the built app (app/dist), production mode.
// Kept disk-only and free of the router so it can be swapped/mocked independently.

import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webm': 'audio/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Resolve a request pathname to a file under staticRoot, refusing to escape it.
 *
 * `pathname` always comes from `URL#pathname`, so it is always absolute
 * (leading `/`). `node:path`'s `normalize` already collapses any `..`
 * segments in an absolute path down to root before `join` ever sees them
 * (e.g. `normalize('/../../etc/passwd') === '/etc/passwd'`), so `join`
 * cannot land outside staticRoot on its own. The `startsWith` check below is
 * kept anyway as an explicit, cheap defense-in-depth backstop rather than an
 * implicit trust in path.normalize's behavior.
 * @param {string} pathname
 * @param {string} staticRoot
 * @returns {string}
 */
function resolve_within_root(pathname, staticRoot) {
  const resolved = join(staticRoot, normalize(pathname));
  if (resolved !== staticRoot && !resolved.startsWith(staticRoot + '/')) {
    return join(staticRoot, 'index.html');
  }
  return resolved;
}

/**
 * Resolve filePath to a servable file: itself if it's a regular file, its own
 * index.html if it's a directory that has one, or null otherwise (missing
 * path, or a directory with no index.html of its own).
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function resolve_file_candidate(filePath) {
  try {
    const stats = await stat(filePath);
    if (!stats.isDirectory()) {
      return filePath;
    }
    const indexPath = join(filePath, 'index.html');
    const indexStats = await stat(indexPath).catch(() => null);
    return indexStats?.isFile() ? indexPath : null;
  } catch {
    return null;
  }
}

/**
 * Serve a static file from staticRoot for the given pathname, falling back to
 * the top-level index.html (SPA-style) whenever the requested path doesn't
 * resolve to a real file — including a directory that has no index.html of
 * its own (e.g. an asset directory hit without a specific filename).
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {string} staticRoot
 */
export async function serve_static(res, pathname, staticRoot) {
  const requestedPath = resolve_within_root(pathname, staticRoot);
  const candidate = await resolve_file_candidate(requestedPath);
  const filePath = candidate ?? join(staticRoot, 'index.html');

  try {
    const data = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}
