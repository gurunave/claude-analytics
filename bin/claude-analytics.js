#!/usr/bin/env node
/**
 * claude-analytics — deep analytics over local Claude Code usage.
 *
 *   claude-analytics                 start the dashboard on http://127.0.0.1:4785
 *   claude-analytics --port 8080     use a different port
 *   claude-analytics --summary       print a terminal summary and exit
 *   claude-analytics --json          dump the full report as JSON and exit
 *   claude-analytics --since 2026-07-01
 *   claude-analytics --dir /path/to/.claude/projects
 */

import { createDashboardServer } from '../src/server.js';
import { loadUsage, defaultProjectsDir } from '../src/parser.js';
import { buildReport } from '../src/analytics.js';

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT) || 4785,
    host: '127.0.0.1',
    dir: defaultProjectsDir(),
    since: null,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    mode: 'serve',
    open: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--port': opts.port = Number(next()); break;
      case '--host': opts.host = next(); break;
      case '--dir': opts.dir = next(); break;
      case '--since': opts.since = next(); break;
      case '--tz': opts.tz = next(); break;
      case '--summary': opts.mode = 'summary'; break;
      case '--json': opts.mode = 'json'; break;
      case '--no-open': opts.open = false; break;
      case '--help':
      case '-h': opts.mode = 'help'; break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(2);
        }
    }
  }
  return opts;
}

const usd = (n) => `$${n.toFixed(n < 10 ? 4 : 2)}`;
const num = (n) => n.toLocaleString('en-US');
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function tokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function printSummary(report) {
  const t = report.totals;
  const line = '─'.repeat(58);
  console.log(`\n  Claude Code usage — ${t.firstActivity ?? 'n/a'} to ${t.lastActivity ?? 'n/a'}`);
  console.log(`  ${line}`);
  console.log(`  Total spend        ${usd(t.cost)}`);
  console.log(`  Saved by caching   ${usd(t.cacheSavings)}  (${pct(t.cacheHitRate)} hit rate)`);
  console.log(`  Tokens             ${tokens(t.totalTokens)}  (${tokens(t.outputTokens)} output)`);
  console.log(`  Sessions           ${num(t.sessions)} across ${num(t.projects)} projects`);
  console.log(`  Assistant turns    ${num(t.turns)}  (${num(t.toolInvocations)} tool calls)`);
  console.log(`  Per session        avg ${usd(t.avgCostPerSession)} · median ${usd(t.medianSessionCost)} · p95 ${usd(t.p95SessionCost)}`);
  console.log(`  Per active day     ${usd(t.avgCostPerActiveDay)} over ${num(t.activeDays)} days`);

  console.log(`\n  By model`);
  console.log(`  ${line}`);
  for (const m of report.byModel.slice(0, 8)) {
    const share = t.cost ? m.cost / t.cost : 0;
    console.log(`  ${m.model.padEnd(22)} ${usd(m.cost).padStart(10)}  ${pct(share).padStart(6)}  ${num(m.turns)} turns`);
  }

  console.log(`\n  Top projects`);
  console.log(`  ${line}`);
  for (const p of report.byProject.slice(0, 8)) {
    const name = p.project.length > 34 ? '…' + p.project.slice(-33) : p.project;
    console.log(`  ${name.padEnd(36)} ${usd(p.cost).padStart(10)}  ${num(p.turns)} turns`);
  }

  console.log(`\n  Top tools`);
  console.log(`  ${line}`);
  for (const tool of report.byTool.slice(0, 10)) {
    console.log(`  ${tool.tool.padEnd(30)} ${num(tool.count).padStart(6)}  ${pct(tool.share).padStart(6)}`);
  }
  console.log('');
}

const opts = parseArgs(process.argv.slice(2));

if (opts.mode === 'help') {
  console.log(`
  claude-analytics — deep analytics over local Claude Code usage

    --port <n>      dashboard port (default 4785)
    --host <addr>   bind address (default 127.0.0.1)
    --dir <path>    transcripts dir (default ~/.claude/projects)
    --since <date>  only include activity on/after this ISO date
    --tz <zone>     IANA timezone for day/hour bucketing (default: system)
    --summary       print a terminal summary and exit
    --json          print the full JSON report and exit
    -h, --help      show this help
`);
  process.exit(0);
}

if (opts.mode === 'summary' || opts.mode === 'json') {
  const { turns, sessions, stats } = await loadUsage({ root: opts.dir, since: opts.since });
  if (!turns.length) {
    console.error(`No usage found under ${stats.root}. Point --dir at your transcripts directory.`);
    process.exit(1);
  }
  const report = buildReport(turns, sessions, { timeZone: opts.tz });
  if (opts.mode === 'json') console.log(JSON.stringify({ ...report, scan: stats }, null, 2));
  else printSummary(report);
  process.exit(0);
}

const server = createDashboardServer({ root: opts.dir });
server.listen(opts.port, opts.host, () => {
  console.log(`\n  claude-analytics running at http://${opts.host}:${opts.port}`);
  console.log(`  reading transcripts from ${opts.dir}`);
  console.log(`  press ctrl-c to stop\n`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${opts.port} is in use. Try --port ${opts.port + 1}.`);
    process.exit(1);
  }
  throw err;
});
