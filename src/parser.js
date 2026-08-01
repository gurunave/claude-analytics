/**
 * Reads Claude Code's local session transcripts and flattens them into
 * normalized records the analytics layer can aggregate.
 *
 * Transcripts live at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, one
 * JSON object per line. The lines we care about:
 *
 *   {"type":"assistant","message":{"model":...,"usage":{...},"content":[...]},...}
 *   {"type":"user","message":{"role":"user","content":...},...}
 *   {"type":"queue-operation",...}   // prompt queueing, ignored
 *   {"type":"attachment",...}        // tool/context attachments, ignored
 *
 * Every line also carries sessionId, timestamp, cwd, gitBranch, version, and
 * (on assistant lines) requestId and effort.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';

import { costOf, modelInfo } from './pricing.js';

export function defaultProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects');
}

/**
 * Directory names encode the project cwd with '/' replaced by '-', which is
 * lossy (a real '-' in a path is indistinguishable). Prefer the `cwd` field
 * carried on the entries themselves; fall back to the decoded directory name.
 */
function decodeProjectDir(name) {
  return name.startsWith('-') ? '/' + name.slice(1).replace(/-/g, '/') : name.replace(/-/g, '/');
}

async function* walkTranscripts(root) {
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(root, dir.name);
    let files;
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      yield {
        file: path.join(projectPath, file),
        projectDir: dir.name,
        projectPath: decodeProjectDir(dir.name),
      };
    }
  }
}

function textLength(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') n += block.text.length;
  }
  return n;
}

function toolNames(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === 'tool_use' && b.name).map((b) => b.name);
}

function hasThinking(content) {
  return Array.isArray(content) && content.some((b) => b?.type === 'thinking');
}

/**
 * Parse one transcript file into { turns, sessionMeta }.
 *
 * Assistant entries are deduplicated by requestId: a single API request can be
 * written to the transcript more than once (streaming reconnects, retries), and
 * counting both would double-bill the session.
 */
async function parseFile({ file, projectPath, projectDir }) {
  const turns = [];
  const seenRequests = new Map();
  const session = {
    id: path.basename(file, '.jsonl'),
    file,
    projectDir,
    projectPath,
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    firstPrompt: null,
    userMessages: 0,
    interrupts: 0,
    toolDenials: 0,
    parseErrors: 0,
    start: null,
    end: null,
  };

  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      session.parseErrors += 1;
      continue;
    }

    if (entry.cwd) session.cwd = entry.cwd;
    if (entry.gitBranch) session.gitBranch = entry.gitBranch;
    if (entry.version) session.version = entry.version;
    if (entry.entrypoint) session.entrypoint = entry.entrypoint;
    if (entry.toolDenialKind) session.toolDenials += 1;

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (session.start === null || ts < session.start) session.start = ts;
      if (session.end === null || ts > session.end) session.end = ts;
    }

    if (entry.type === 'user') {
      // Sidechain entries are subagent traffic; tool results are not prompts.
      const content = entry.message?.content;
      const isToolResult =
        Array.isArray(content) && content.some((b) => b?.type === 'tool_result');
      if (!isToolResult && !entry.isMeta) {
        session.userMessages += 1;
        if (session.firstPrompt === null && typeof content === 'string') {
          session.firstPrompt = content.slice(0, 200);
        }
      }
      if (entry.interruptedByShutdown) session.interrupts += 1;
      continue;
    }

    if (entry.type !== 'assistant') continue;

    const msg = entry.message ?? {};
    const usage = msg.usage;
    if (!usage) continue;

    // One API request is written as several assistant lines — one per content
    // block (thinking, text, tool_use) — all carrying the same requestId and an
    // identical usage object. Bill the request once, but merge the content of
    // every line into that single turn so no tool calls are lost.
    const requestId = entry.requestId ?? msg.id;
    if (requestId && seenRequests.has(requestId)) {
      const turn = seenRequests.get(requestId);
      turn.tools.push(...toolNames(msg.content));
      turn.textChars += textLength(msg.content);
      turn.thinking = turn.thinking || hasThinking(msg.content);
      if (msg.stop_reason) turn.stopReason = msg.stop_reason;
      continue;
    }

    const speed = usage.speed ?? 'standard';
    const cost = costOf(usage, msg.model, speed);
    const info = modelInfo(msg.model);

    const turn = {
      sessionId: entry.sessionId ?? session.id,
      projectPath: entry.cwd ?? projectPath,
      gitBranch: entry.gitBranch ?? null,
      version: entry.version ?? null,
      timestamp: Number.isFinite(ts) ? ts : null,
      model: info.id,
      modelDisplay: info.display,
      tier: info.tier,
      effort: entry.effort ?? null,
      speed: usage.speed ?? 'standard',
      serviceTier: usage.service_tier ?? null,
      stopReason: msg.stop_reason ?? null,
      isSidechain: Boolean(entry.isSidechain),
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheWrite5m:
        usage.cache_creation?.ephemeral_5m_input_tokens ??
        Math.max(
          0,
          (usage.cache_creation_input_tokens ?? 0) -
            (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
        ),
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
      webFetches: usage.server_tool_use?.web_fetch_requests ?? 0,
      thinking: hasThinking(msg.content),
      tools: toolNames(msg.content),
      textChars: textLength(msg.content),
      cost,
    };
    turns.push(turn);
    if (requestId) seenRequests.set(requestId, turn);
  }

  return { turns, session };
}

/**
 * Load every transcript under `root`.
 *
 * Returns { turns, sessions, stats }. Files that fail to open are skipped and
 * counted in stats.skippedFiles rather than aborting the whole scan.
 */
export async function loadUsage({ root = defaultProjectsDir(), since = null } = {}) {
  const turns = [];
  const sessions = [];
  const stats = { files: 0, skippedFiles: 0, parseErrors: 0, root };

  const targets = [];
  for await (const t of walkTranscripts(root)) targets.push(t);

  // Bounded concurrency: transcripts are IO-bound and there can be thousands.
  const CONCURRENCY = 16;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      try {
        const { turns: t, session } = await parseFile(target);
        const info = await stat(target.file).catch(() => null);
        session.sizeBytes = info?.size ?? 0;
        stats.files += 1;
        stats.parseErrors += session.parseErrors;
        if (t.length || session.userMessages) {
          sessions.push(session);
          turns.push(...t);
        }
      } catch {
        stats.skippedFiles += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  const cutoff = since ? Date.parse(since) : null;
  const filtered =
    cutoff && Number.isFinite(cutoff)
      ? turns.filter((t) => t.timestamp !== null && t.timestamp >= cutoff)
      : turns;

  filtered.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return { turns: filtered, sessions, stats };
}
