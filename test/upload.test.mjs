/** Upload/analyze endpoint. Run with: npm test */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createDashboardServer } from '../src/server.js';
import { parseTranscriptText } from '../src/parser.js';

const USAGE = {
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 1_000,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 },
};

const line = (content, requestId = 'req_1') =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-upload',
    requestId,
    timestamp: '2026-07-01T10:00:00.000Z',
    cwd: '/home/dev/proj',
    message: { model: 'claude-opus-5', usage: USAGE, stop_reason: 'end_turn', content },
  });

const TRANSCRIPT = [
  line([{ type: 'thinking', thinking: '...' }]),
  line([{ type: 'text', text: 'hello' }]),
  line([{ type: 'tool_use', name: 'Bash', input: {} }]),
  line([{ type: 'text', text: 'second' }], 'req_2'),
].join('\n');

// Point the local-scan path at a directory that doesn't exist, so these tests
// exercise uploads without depending on the machine's real transcripts.
const server = createDashboardServer({ root: '/nonexistent/xyz' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const post = (files) =>
  fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  });

test('parseTranscriptText applies the same dedup rules as a file scan', () => {
  const { turns } = parseTranscriptText(TRANSCRIPT, { name: 'a.jsonl' });
  assert.equal(turns.length, 2, 'two requests -> two billed turns');
  assert.deepEqual(turns[0].tools, ['Bash']);
  assert.equal(turns[0].outputTokens, 200);
});

test('uploaded transcripts produce a fetchable report', async () => {
  const res = await post([{ name: 'a.jsonl', text: TRANSCRIPT }]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.turns, 2);
  assert.equal(body.sessions, 1);

  const reportRes = await fetch(`${base}/api/report?source=${body.id}&tz=UTC`);
  assert.equal(reportRes.status, 200);
  const report = await reportRes.json();
  assert.equal(report.totals.turns, 2);
  assert.equal(report.source.uploaded, true);
  assert.equal(report.byTool[0].tool, 'Bash');
});

test('a file with no usage entries is rejected rather than reported as zero', async () => {
  const res = await post([{ name: 'notes.jsonl', text: '{"type":"user","message":{"content":"hi"}}' }]);
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /No billable assistant turns/);
});

test('malformed and empty submissions are rejected with a clear error', async () => {
  assert.equal((await post([])).status, 400);
  const bad = await post([{ name: 'x.jsonl' }]); // no text field
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /no text content/);
});

test('an unknown source id is a 404, not a silent empty report', async () => {
  const res = await fetch(`${base}/api/report?source=does-not-exist`);
  assert.equal(res.status, 404);
});

test('the since filter applies to uploaded data too', async () => {
  const { id } = await (await post([{ name: 'a.jsonl', text: TRANSCRIPT }])).json();
  const res = await fetch(`${base}/api/report?source=${id}&since=2030-01-01&tz=UTC`);
  const report = await res.json();
  assert.equal(report.totals.turns, 0, 'everything predates the cutoff');
});

test('only the most recent uploads are retained', async () => {
  const ids = [];
  for (let i = 0; i < 7; i += 1) {
    const { id } = await (await post([{ name: `f${i}.jsonl`, text: TRANSCRIPT }])).json();
    ids.push(id);
  }
  const oldest = await fetch(`${base}/api/report?source=${ids[0]}`);
  assert.equal(oldest.status, 404, 'oldest dataset should have been evicted');
  const newest = await fetch(`${base}/api/report?source=${ids.at(-1)}`);
  assert.equal(newest.status, 200);
});
