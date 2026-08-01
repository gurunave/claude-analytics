# claude-analytics

A deep analytics dashboard for your Claude Code usage, built entirely from the
session transcripts already on your machine. No API key, no telemetry, no
network calls — it reads `~/.claude/projects`, costs every request against the
published model rates, and serves a local dashboard.

![dashboard](docs/dashboard.png)

## Quick start

```bash
node bin/claude-analytics.js
# → http://127.0.0.1:4785
```

Requires Node 18+. There are no dependencies to install.

```bash
node bin/claude-analytics.js --summary       # terminal summary, no server
node bin/claude-analytics.js --json          # full report as JSON
node bin/claude-analytics.js --since 2026-07-01
node bin/claude-analytics.js --port 8080
node bin/claude-analytics.js --dir /path/to/.claude/projects
node bin/claude-analytics.js --tz America/New_York
```

## What it shows

| Panel | What it answers |
|---|---|
| Stat tiles | Total spend, dollars saved by prompt caching, tokens, sessions, median/p95 session cost, spend per active day |
| Spend over time | Daily cost with a crosshair showing that day's turns, output tokens, and cache hit rate |
| What you are paying for | The split across output, cache writes, uncached input, and cache reads — usually the most surprising chart |
| Spend by model / project | Where the money goes, with a table view for each |
| When you work | Weekday × hour heatmap of spend |
| Tool usage | Every tool call, with MCP tools distinguished |
| Reasoning effort | Turns and cost per effort level |
| Sessions | Every session, most expensive first, with duration and branch |

## How costs are computed

Each assistant turn carries a `usage` object. Tokens are billed at the
first-party API rates in `src/pricing.js`:

- **input** and **output** at the model's published per-million rates
- **cache reads** at `0.1×` the input rate
- **cache writes** at `1.25×` (5-minute TTL) or `2×` (1-hour TTL) — the two are
  costed separately when the transcript reports the breakdown
- **fast mode** (`speed: "fast"`) at its own premium rate

"Saved by caching" is a net figure: what the cache-read tokens would have cost
at full input price, minus what they actually cost, minus the premium already
paid on cache writes. It is not gross savings.

Two things worth knowing about the numbers:

- Rates are **first-party Claude API**. Transcripts from Amazon Bedrock or
  Vertex AI are recognized and normalized, but costed at first-party rates —
  those platforms are partner-operated and priced separately. Edit
  `src/pricing.js` if you need their rates.
- Model IDs are normalized before lookup, so `anthropic.claude-sonnet-4-6`,
  `claude-haiku-4-5-20251001`, and `claude-haiku-4-5` all resolve correctly.
  An unrecognized model is costed at zero rather than guessed at, so a sudden
  drop in reported spend usually means a new model needs a table entry.

## Transcript quirks it handles

These are the things that make a naive parser wrong:

- **One request writes several lines.** A single API request is written as one
  line per content block — thinking, text, and tool_use each get their own —
  all carrying the same `requestId` and an *identical* `usage` object. Counting
  each line double-bills the session; deduplicating by `requestId` and keeping
  only the first line silently drops most tool calls. The parser bills once per
  request and merges content across all of its lines.
- **Tool results are not prompts.** `type: "user"` entries include tool results
  and meta entries; only genuine human turns are counted as user messages.
- **Directory names are lossy.** `~/.claude/projects/-home-user-foo` can't be
  reliably decoded back to a path, so the `cwd` field on the entries themselves
  is preferred.
- Malformed lines are counted, not fatal — a partially-written transcript from
  a live session still parses.

## JSON API

The server exposes the full report if you'd rather build on it:

| Endpoint | Returns |
|---|---|
| `GET /api/report?since=&tz=` | The complete report object |
| `GET /api/session?id=` | One session's rollup |
| `GET /api/models` | The pricing table |

The report includes several breakdowns the dashboard doesn't render —
`byBranch`, `byVersion`, `byStopReason`, and `hourly`.

## Layout

```
bin/claude-analytics.js   CLI entry point (serve / --summary / --json)
src/pricing.js            model table, ID normalization, per-request costing
src/parser.js             transcript discovery and flattening
src/analytics.js          pure aggregations over flattened turns
src/server.js             static file + JSON API server
public/                   dashboard (no build step, no dependencies)
```

## Privacy

The server binds to `127.0.0.1` by default and the report includes project
paths and the opening line of prompts. Use `--host` to change the bind address
only if you understand that.
