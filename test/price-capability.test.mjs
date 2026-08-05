/** Run with: node --test test/ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUploads } from '../src/parser.js';
import { buildReport, effectiveBlendedPrice } from '../src/analytics.js';
import { providerOf, blendedListPrice, modelInfo, listModels } from '../src/pricing.js';

const line = (model, usage, requestId) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-1',
    requestId,
    timestamp: '2026-07-01T10:00:00.000Z',
    cwd: '/home/dev/proj',
    message: { model, usage, stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
  });

/** 1M uncached input + 1M output, nothing cached — easy arithmetic. */
const PLAIN = { input_tokens: 1e6, output_tokens: 1e6 };

test('providerOf reads the serving platform off the raw model id', () => {
  assert.equal(providerOf('claude-opus-5').id, 'anthropic');
  assert.equal(providerOf('anthropic.claude-sonnet-4-6').id, 'bedrock');
  assert.equal(providerOf('us.anthropic.claude-opus-5').id, 'bedrock');
  assert.equal(providerOf('claude-opus-4-5@20251101').id, 'vertex');
  assert.equal(providerOf(null).id, 'unknown');
});

test('every priced model carries a capability index', () => {
  for (const m of listModels()) {
    assert.equal(typeof m.capability, 'number', `${m.id} has no capability index`);
    assert.ok(m.capability > 0 && m.capability <= 100, `${m.id} index out of range`);
  }
  // Ordinal, not absolute: newer beats older within a tier, opus beats haiku.
  assert.ok(modelInfo('claude-opus-5').capability > modelInfo('claude-opus-4-5').capability);
  assert.ok(modelInfo('claude-sonnet-5').capability > modelInfo('claude-haiku-4-5').capability);
});

test('blendedListPrice weights input 3:1 by default', () => {
  // Opus 5: $5 in, $25 out -> 0.75*5 + 0.25*25 = 10.
  assert.equal(blendedListPrice('claude-opus-5'), 10);
  assert.equal(blendedListPrice('claude-opus-5', 1), 5);
  assert.equal(blendedListPrice('claude-opus-5', 0), 25);
});

test('effectiveBlendedPrice is dollars per million billed tokens', () => {
  const row = { cost: 30, inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(effectiveBlendedPrice(row), 15);
  assert.equal(
    effectiveBlendedPrice({ cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    null,
  );
});

test('price/capability rows are split per model and provider', () => {
  const { turns, sessions } = parseUploads([
    {
      name: 'a.jsonl',
      text: [
        line('claude-opus-5', PLAIN, 'r1'),
        line('anthropic.claude-opus-5', PLAIN, 'r2'),
        line('claude-haiku-4-5', PLAIN, 'r3'),
      ].join('\n'),
    },
  ]);
  const report = buildReport(turns, sessions);
  const rows = report.priceCapability.rows;

  assert.equal(rows.length, 3);
  const opus = rows.filter((r) => r.model === 'claude-opus-5');
  assert.deepEqual(opus.map((r) => r.provider).sort(), ['anthropic', 'bedrock']);
  // 1M in at $5 + 1M out at $25 = $30 over 2M tokens.
  assert.equal(opus[0].effectiveBlended, 15);
  assert.equal(opus[0].listBlended, 10);
  assert.equal(opus[0].capability, modelInfo('claude-opus-5').capability);

  const haiku = rows.find((r) => r.model === 'claude-haiku-4-5');
  assert.equal(haiku.effectiveBlended, 3); // ($1 + $5) / 2M tokens
  assert.ok(haiku.capability < opus[0].capability);

  // Providers roll up for the filter, and totals expose the blended rate.
  assert.deepEqual(
    report.byProvider.map((p) => p.provider).sort(),
    ['Amazon Bedrock', 'Anthropic API'],
  );
  // $30 + $30 + $6 over 6M tokens.
  assert.equal(report.totals.blendedPrice, 11);
});

test('cache discounts pull the effective price below list', () => {
  const cached = {
    input_tokens: 0,
    output_tokens: 1000,
    cache_read_input_tokens: 1e6,
    cache_creation_input_tokens: 0,
  };
  const { turns, sessions } = parseUploads([
    { name: 'a.jsonl', text: line('claude-opus-5', cached, 'r1') },
  ]);
  const row = buildReport(turns, sessions).priceCapability.rows[0];
  assert.ok(row.effectiveBlended < row.listBlended, 'cache reads should undercut list price');
});
