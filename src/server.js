/**
 * Local HTTP server: serves the dashboard and a small JSON API over the
 * transcripts on this machine, plus ad-hoc analysis of uploaded transcripts.
 *
 * Binds to 127.0.0.1 by default. The data it exposes includes prompt excerpts
 * and project paths, so don't bind it to a public interface.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadUsage, parseUploads, applySince, defaultProjectsDir } from './parser.js';
import { buildReport } from './analytics.js';
import { listModels } from './pricing.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Uploads are held in memory only, so cap both the body and the retained set. */
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_RETAINED_UPLOADS = 5;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Cache the parse for a few seconds so rapid UI navigation doesn't re-read every file. */
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

/** Read a JSON request body with a hard size ceiling. */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('upload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('request body was not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
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
  /** id -> { turns, sessions, stats, label, at } for uploaded datasets. */
  const uploads = new Map();

  function reportFrom(turns, sessions, stats, { since, timeZone }) {
    const built = buildReport(applySince(turns, since), sessions, { timeZone });
    return { ...built, scan: stats };
  }

  async function report(url) {
    const since = url.searchParams.get('since');
    const timeZone = url.searchParams.get('tz') || 'UTC';
    const source = url.searchParams.get('source');

    if (source) {
      const set = uploads.get(source);
      if (!set) {
        const err = new Error('uploaded dataset not found — it may have expired; upload again');
        err.status = 404;
        throw err;
      }
      return {
        ...reportFrom(set.turns, set.sessions, set.stats, { since, timeZone }),
        source: { id: source, label: set.label, uploaded: true },
      };
    }

    // Cache the raw scan, not the report, so changing the range or timezone
    // re-aggregates in memory instead of re-reading every transcript.
    const raw = await cached('scan', () => loadUsage({ root }));
    return {
      ...reportFrom(raw.turns, raw.sessions, raw.stats, { since, timeZone }),
      source: { id: null, label: root, uploaded: false },
    };
  }

  async function analyze(req, res) {
    const body = await readJsonBody(req, MAX_UPLOAD_BYTES);
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) return sendJson(res, 400, { error: 'no files provided' });
    for (const f of files) {
      if (typeof f?.text !== 'string') {
        return sendJson(res, 400, { error: `file "${f?.name ?? '?'}" had no text content` });
      }
    }

    const { turns, sessions, stats } = parseUploads(files);
    if (!turns.length) {
      return sendJson(res, 422, {
        error:
          'No billable assistant turns found. Expected Claude Code .jsonl transcripts — ' +
          'one JSON object per line, with assistant entries carrying message.usage.',
        filesRead: stats.files,
        parseErrors: stats.parseErrors,
      });
    }

    const id = randomUUID();
    const label =
      files.length === 1 ? files[0].name : `${files.length} files`;
    uploads.set(id, { turns, sessions, stats, label, at: Date.now() });
    // Evict oldest so a long-lived server can't accumulate transcripts in memory.
    while (uploads.size > MAX_RETAINED_UPLOADS) {
      const oldest = [...uploads.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      uploads.delete(oldest[0]);
    }

    sendJson(res, 200, {
      id,
      label,
      files: stats.files,
      turns: turns.length,
      sessions: sessions.length,
      parseErrors: stats.parseErrors,
    });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/analyze') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
        return await analyze(req, res);
      }
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
      sendJson(res, err?.status ?? 500, { error: err?.message ?? 'internal error' });
    }
  });
}
