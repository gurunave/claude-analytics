/**
 * Aggregations over the flattened turn records from parser.js.
 *
 * Everything here is pure: given the same turns, you get the same report. The
 * server calls buildReport() per request; the CLI calls it once.
 */

import { modelInfo } from './pricing.js';

const EMPTY_TOTALS = () => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  webSearches: 0,
  webFetches: 0,
  thinkingTurns: 0,
  textChars: 0,
  cost: 0,
  costInput: 0,
  costOutput: 0,
  costCacheWrite: 0,
  costCacheRead: 0,
});

function accumulate(acc, t) {
  acc.turns += 1;
  acc.inputTokens += t.inputTokens;
  acc.outputTokens += t.outputTokens;
  acc.cacheReadTokens += t.cacheReadTokens;
  acc.cacheWriteTokens += t.cacheWriteTokens;
  acc.cacheWrite1h += t.cacheWrite1h;
  acc.cacheWrite5m += t.cacheWrite5m;
  acc.webSearches += t.webSearches;
  acc.webFetches += t.webFetches;
  acc.thinkingTurns += t.thinking ? 1 : 0;
  acc.textChars += t.textChars;
  acc.cost += t.cost.total;
  acc.costInput += t.cost.input;
  acc.costOutput += t.cost.output;
  acc.costCacheWrite += t.cost.cacheWrite;
  acc.costCacheRead += t.cost.cacheRead;
  return acc;
}

function groupBy(turns, keyFn) {
  const map = new Map();
  for (const t of turns) {
    const key = keyFn(t);
    if (key === null || key === undefined) continue;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = EMPTY_TOTALS();
      map.set(key, bucket);
    }
    accumulate(bucket, t);
  }
  return map;
}

function toSortedRows(map, keyName, sortKey = 'cost') {
  return [...map.entries()]
    .map(([key, v]) => ({ [keyName]: key, ...v }))
    .sort((a, b) => b[sortKey] - a[sortKey]);
}

function dayKey(ts, tz) {
  // en-CA gives ISO-ish YYYY-MM-DD, and the timeZone option keeps buckets
  // aligned to the viewer's local days rather than UTC days.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

function hourOf(ts, tz) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(new Date(ts));
  return Number.parseInt(h, 10) % 24;
}

function weekdayOf(ts, tz) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(
    new Date(ts),
  );
  return Math.max(0, names.indexOf(short));
}

/** Total tokens billed at any rate — the denominator for cache-hit ratios. */
function promptTokens(row) {
  return row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function buildReport(turns, sessions, { timeZone = 'UTC' } = {}) {
  const totals = turns.reduce(accumulate, EMPTY_TOTALS());

  const byModel = toSortedRows(groupBy(turns, (t) => t.modelDisplay), 'model');
  const byProject = toSortedRows(groupBy(turns, (t) => t.projectPath), 'project');
  const byBranch = toSortedRows(groupBy(turns, (t) => t.gitBranch), 'branch');
  const byEffort = toSortedRows(groupBy(turns, (t) => t.effort ?? 'unset'), 'effort');
  const byVersion = toSortedRows(groupBy(turns, (t) => t.version ?? 'unknown'), 'version');
  const byStopReason = toSortedRows(groupBy(turns, (t) => t.stopReason ?? 'none'), 'stopReason');

  const daily = toSortedRows(
    groupBy(turns, (t) => (t.timestamp ? dayKey(t.timestamp, timeZone) : null)),
    'date',
  ).sort((a, b) => a.date.localeCompare(b.date));

  // Running cumulative cost makes the burn-rate trend readable at a glance.
  let running = 0;
  for (const d of daily) {
    running += d.cost;
    d.cumulativeCost = running;
  }

  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, ...EMPTY_TOTALS() }));
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const t of turns) {
    if (!t.timestamp) continue;
    const h = hourOf(t.timestamp, timeZone);
    accumulate(hourly[h], t);
    heatmap[weekdayOf(t.timestamp, timeZone)][h] += t.cost.total;
  }

  // Tool usage is per-invocation, not per-turn: one assistant message can call
  // several tools, and the same tool more than once.
  const toolCounts = new Map();
  let toolInvocations = 0;
  for (const t of turns) {
    for (const name of t.tools) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      toolInvocations += 1;
    }
  }
  const byTool = [...toolCounts.entries()]
    .map(([tool, count]) => ({
      tool,
      count,
      share: toolInvocations ? count / toolInvocations : 0,
      mcp: tool.startsWith('mcp__'),
    }))
    .sort((a, b) => b.count - a.count);

  // Per-session rollup, joined back onto the session metadata from the parser.
  const sessionTotals = groupBy(turns, (t) => t.sessionId);
  const metaById = new Map(sessions.map((s) => [s.id, s]));
  const sessionRows = [...sessionTotals.entries()]
    .map(([id, v]) => {
      const meta = metaById.get(id) ?? {};
      const durationMs = meta.start && meta.end ? meta.end - meta.start : 0;
      return {
        id,
        project: meta.cwd ?? meta.projectPath ?? 'unknown',
        branch: meta.gitBranch ?? null,
        version: meta.version ?? null,
        entrypoint: meta.entrypoint ?? null,
        firstPrompt: meta.firstPrompt ?? null,
        userMessages: meta.userMessages ?? 0,
        start: meta.start ?? null,
        end: meta.end ?? null,
        durationMs,
        costPerHour: durationMs > 3.6e5 ? v.cost / (durationMs / 3.6e6) : null,
        ...v,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  const sessionCosts = sessionRows.map((s) => s.cost).sort((a, b) => a - b);
  const turnCosts = turns.map((t) => t.cost.total).sort((a, b) => a - b);

  const prompt = promptTokens(totals);
  const activeDays = daily.length;
  const span =
    daily.length > 1
      ? (Date.parse(daily.at(-1).date) - Date.parse(daily[0].date)) / 864e5 + 1
      : activeDays;

  return {
    generatedAt: new Date().toISOString(),
    timeZone,
    totals: {
      ...totals,
      sessions: sessionRows.length,
      projects: byProject.length,
      models: byModel.length,
      toolInvocations,
      userMessages: sessionRows.reduce((n, s) => n + s.userMessages, 0),
      promptTokens: prompt,
      totalTokens: prompt + totals.outputTokens,
      cacheHitRate: prompt ? totals.cacheReadTokens / prompt : 0,
      // What the same prompt tokens would have cost with no cache at all.
      cacheSavings: estimateCacheSavings(turns),
      avgCostPerSession: sessionRows.length ? totals.cost / sessionRows.length : 0,
      avgCostPerTurn: totals.turns ? totals.cost / totals.turns : 0,
      medianTurnCost: percentile(turnCosts, 50),
      p95TurnCost: percentile(turnCosts, 95),
      medianSessionCost: percentile(sessionCosts, 50),
      p95SessionCost: percentile(sessionCosts, 95),
      activeDays,
      calendarDays: span,
      avgCostPerActiveDay: activeDays ? totals.cost / activeDays : 0,
      firstActivity: daily[0]?.date ?? null,
      lastActivity: daily.at(-1)?.date ?? null,
      thinkingRate: totals.turns ? totals.thinkingTurns / totals.turns : 0,
      outputPerTurn: totals.turns ? totals.outputTokens / totals.turns : 0,
    },
    byModel,
    byProject,
    byBranch: byBranch.filter((b) => b.branch),
    byEffort,
    byVersion,
    byStopReason,
    byTool,
    daily,
    hourly,
    heatmap,
    sessions: sessionRows,
  };
}

/**
 * Dollars saved by prompt caching.
 *
 * Cache reads bill at 0.1x input, so the counterfactual is the same tokens at
 * full input price. Writes cost *more* than uncached input (1.25x / 2x), so the
 * premium already paid is subtracted — this is net savings, not gross.
 */
function estimateCacheSavings(turns) {
  let saved = 0;
  for (const t of turns) {
    const rate = modelInfo(t.model).input / 1e6; // USD per token at full input price
    // Reads: would have cost full price, actually cost 0.1x.
    saved += t.cacheReadTokens * rate - t.cost.cacheRead;
    // Writes: would have cost full price, actually cost 1.25x (5m) or 2x (1h).
    saved -= t.cost.cacheWrite - (t.cacheWrite5m + t.cacheWrite1h) * rate;
  }
  return saved;
}
