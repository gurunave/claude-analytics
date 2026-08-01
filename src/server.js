/**
 * Local HTTP server: serves the dashboard and a small JSON API over the
 * transcripts on this machine.
 *
 * Binds to 127.0.0.1 by default. The data it exposes includes prompt excerpts
 * and project paths, so don't bind it to a public interface.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadUsage, defaultProjectsDir } from './parser.js';
import { buildReport } from './analytics.js';
import { listModels } from './pricing.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Cache the parse for a few seconds so rapid UI refreshes don't re-read every file. */
function makeCache(ttlMs) {
  let entry = null;
  return async (key, produce) => {
    const now = Date.now();
    if (entry && entry.key === key && now - entry.at < ttlMs) return entry.value;
    const value = await produce();
    entry = { key, value, at: now };
    return value;
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // Path traversal guard: the resolved file must stay inside PUBLIC_DIR.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

export function createDashboardServer({ root = defaultProjectsDir(), cacheMs = 5000 } = {}) {
  const cached = makeCache(cacheMs);

  async function report(url) {
    const since = url.searchParams.get('since');
    const timeZone = url.searchParams.get('tz') || 'UTC';
    const key = `${since ?? ''}|${timeZone}`;
    return cached(key, async () => {
      const { turns, sessions, stats } = await loadUsage({ root, since });
      const built = buildReport(turns, sessions, { timeZone });
      return { ...built, scan: stats };
    });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/report') return sendJson(res, 200, await report(url));
      if (url.pathname === '/api/models') return sendJson(res, 200, { models: listModels() });
      if (url.pathname === '/api/session') {
        const id = url.searchParams.get('id');
        const data = await report(url);
        const session = data.sessions.find((s) => s.id === id);
        if (!session) return sendJson(res, 404, { error: 'session not found' });
        return sendJson(res, 200, session);
      }
      return serveStatic(res, url.pathname);
    } catch (err) {
      sendJson(res, 500, { error: err?.message ?? 'internal error' });
    }
  });
}
