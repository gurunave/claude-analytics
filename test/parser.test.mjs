/** Run with: node --test test/ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadUsage } from '../src/parser.js';
import { buildReport } from '../src/analytics.js';
import { costOf, normalizeModel, modelInfo } from '../src/pricing.js';

async function fixture(lines) {
  const root = await mkdtemp(path.join(tmpdir(), 'ca-test-'));
  const dir = path.join(root, '-home-dev-proj');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  return root;
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 1_000,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 },
};

const assistantLine = (content, requestId = 'req_1') => ({
  type: 'assistant',
  sessionId: 'sess-1',
  requestId,
  timestamp: '2026-07-01T10:00:00.000Z',
  cwd: '/home/dev/proj',
  gitBranch: 'main',
  effort: 'high',
  message: { model: 'claude-opus-5', usage: USAGE, stop_reason: 'tool_use', content },
});

test('normalizeModel strips provider prefixes and date suffixes', () => {
  assert.equal(normalizeModel('anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('us.anthropic.claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
  assert.equal(modelInfo('claude-opus-5').input, 5);
});

test('costOf applies the cache multipliers', () => {
  // Opus 5: $5/MTok input, $25/MTok output.
  const c = costOf(
    {
      input_tokens: 1e6,
      output_tokens: 1e6,
      cache_read_input_tokens: 1e6,
      cache_creation_input_tokens: 2e6,
      cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
    },
    'claude-opus-5',
  );
  assert.equal(c.input, 5);
  assert.equal(c.output, 25);
  assert.equal(c.cacheRead, 0.5); // 0.1x
  assert.equal(c.cacheWrite, 5 * 1.25 + 5 * 2.0); // 5m + 1h
});

test('a 1h cache write costs more than a 5m write of the same size', () => {
  const base = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const fiveMin = costOf(
    { ...base, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 0 } },
    'claude-opus-5',
  );
  const oneHour = costOf(
    { ...base, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } },
    'claude-opus-5',
  );
  assert.ok(oneHour.cacheWrite > fiveMin.cacheWrite);
});

test('sibling lines of one request are billed once but contribute all their tools', async () => {
  // Real transcripts split a single request across one line per content block,
  // each repeating the same usage object.
  const root = await fixture([
    { type: 'user', sessionId: 'sess-1', timestamp: '2026-07-01T09:59:00.000Z', cwd: '/home/dev/proj', message: { role: 'user', content: 'hi' } },
    assistantLine([{ type: 'thinking', thinking: '...' }]),
    assistantLine([{ type: 'text', text: 'working on it' }]),
    assistantLine([{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'tool_use', name: 'Read', input: {} }]),
  ]);

  const { turns } = await loadUsage({ root });
  assert.equal(turns.length, 1, 'one request must produce one billed turn');
  assert.deepEqual(turns[0].tools.sort(), ['Bash', 'Read']);
  assert.equal(turns[0].thinking, true);
  assert.equal(turns[0].outputTokens, 200, 'usage must not be summed across sibling lines');

  const report = buildReport(turns, [], { timeZone: 'UTC' });
  assert.equal(report.totals.toolInvocations, 2);
  assert.equal(report.byTool.length, 2);
});

test('distinct requests are billed separately', async () => {
  const root = await fixture([
    assistantLine([{ type: 'text', text: 'a' }], 'req_1'),
    assistantLine([{ type: 'text', text: 'b' }], 'req_2'),
  ]);
  const { turns } = await loadUsage({ root });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].outputTokens + turns[1].outputTokens, 400);
});

test('tool results are not counted as user prompts', async () => {
  const root = await fixture([
    { type: 'user', sessionId: 'sess-1', timestamp: '2026-07-01T09:59:00.000Z', cwd: '/home/dev/proj', message: { role: 'user', content: 'real prompt' } },
    { type: 'user', sessionId: 'sess-1', timestamp: '2026-07-01T10:01:00.000Z', cwd: '/home/dev/proj', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    assistantLine([{ type: 'text', text: 'a' }]),
  ]);
  const { sessions } = await loadUsage({ root });
  assert.equal(sessions[0].userMessages, 1);
});

test('malformed lines are survivable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ca-test-'));
  const dir = path.join(root, '-home-dev-proj');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'sess-1.jsonl'),
    `${JSON.stringify(assistantLine([{ type: 'text', text: 'a' }]))}\n{"broken":\n`,
  );
  const { turns, stats } = await loadUsage({ root });
  assert.equal(turns.length, 1);
  assert.equal(stats.parseErrors, 1);
});

test('a missing transcripts directory yields an empty report, not a crash', async () => {
  const { turns, stats } = await loadUsage({ root: '/nonexistent/path/xyz' });
  assert.equal(turns.length, 0);
  assert.equal(stats.files, 0);
});

test('cache savings are net of the write premium', async () => {
  const root = await fixture([assistantLine([{ type: 'text', text: 'a' }])]);
  const { turns } = await loadUsage({ root });
  const { totals } = buildReport(turns, [], { timeZone: 'UTC' });
  const rate = 5 / 1e6;
  // 10k reads saved at 0.9x input, minus the 0.25x premium on a 1k 5m write.
  const expected = 10_000 * rate * 0.9 - 1_000 * rate * 0.25;
  assert.ok(Math.abs(totals.cacheSavings - expected) < 1e-9, `${totals.cacheSavings} vs ${expected}`);
});
