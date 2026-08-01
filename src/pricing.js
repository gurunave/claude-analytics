/**
 * Model pricing, in USD per million tokens.
 *
 * `input` / `output` are the published first-party API rates. Cache rates are
 * derived: a 5-minute cache write costs 1.25x input, a 1-hour write 2x input,
 * and a cache read 0.1x input.
 *
 * Rates are first-party Claude API. Bedrock and Vertex are partner-operated and
 * priced separately; transcripts from those routes will be costed at these rates
 * unless you override them (see PRICING_OVERRIDES below).
 */

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

const MODELS = {
  'claude-fable-5': { display: 'Claude Fable 5', input: 10, output: 50, tier: 'fable' },
  'claude-mythos-5': { display: 'Claude Mythos 5', input: 10, output: 50, tier: 'fable' },
  'claude-opus-5': { display: 'Claude Opus 5', input: 5, output: 25, tier: 'opus' },
  'claude-opus-4-8': { display: 'Claude Opus 4.8', input: 5, output: 25, tier: 'opus' },
  'claude-opus-4-7': { display: 'Claude Opus 4.7', input: 5, output: 25, tier: 'opus' },
  'claude-opus-4-6': { display: 'Claude Opus 4.6', input: 5, output: 25, tier: 'opus' },
  'claude-opus-4-5': { display: 'Claude Opus 4.5', input: 5, output: 25, tier: 'opus' },
  'claude-opus-4-1': { display: 'Claude Opus 4.1', input: 15, output: 75, tier: 'opus' },
  'claude-opus-4-0': { display: 'Claude Opus 4', input: 15, output: 75, tier: 'opus' },
  'claude-sonnet-5': { display: 'Claude Sonnet 5', input: 3, output: 15, tier: 'sonnet' },
  'claude-sonnet-4-6': { display: 'Claude Sonnet 4.6', input: 3, output: 15, tier: 'sonnet' },
  'claude-sonnet-4-5': { display: 'Claude Sonnet 4.5', input: 3, output: 15, tier: 'sonnet' },
  'claude-sonnet-4-0': { display: 'Claude Sonnet 4', input: 3, output: 15, tier: 'sonnet' },
  'claude-haiku-4-5': { display: 'Claude Haiku 4.5', input: 1, output: 5, tier: 'haiku' },
  'claude-3-5-haiku': { display: 'Claude Haiku 3.5', input: 0.8, output: 4, tier: 'haiku' },
  'claude-3-haiku': { display: 'Claude Haiku 3', input: 0.25, output: 1.25, tier: 'haiku' },
};

// Fast mode runs the same model at premium pricing.
const FAST_MODE = {
  'claude-opus-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 10, output: 50 },
};

const UNKNOWN = { display: 'unknown', input: 0, output: 0, tier: 'unknown' };

/**
 * Transcript model strings carry provider prefixes and date suffixes that the
 * pricing table doesn't. Strip them down to a canonical key.
 */
export function normalizeModel(raw) {
  if (!raw) return null;
  let id = String(raw).trim().toLowerCase();
  id = id.replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.|apac\.anthropic\.)/, '');
  id = id.replace(/[:@]\d+$/, ''); // Bedrock ":0" / Vertex "@20251101"
  id = id.replace(/-fast$/, '');
  if (MODELS[id]) return id;
  // Dated snapshots: claude-haiku-4-5-20251001 -> claude-haiku-4-5
  const undated = id.replace(/-\d{8}$/, '');
  if (MODELS[undated]) return undated;
  // Legacy 3.x naming puts the tier before the version.
  const legacy = undated.match(/^claude-3(?:-5|-7)?-(haiku|sonnet|opus)/);
  if (legacy) {
    const guess = undated.startsWith('claude-3-5')
      ? `claude-3-5-${legacy[1]}`
      : `claude-3-${legacy[1]}`;
    if (MODELS[guess]) return guess;
  }
  return id;
}

export function modelInfo(raw) {
  const id = normalizeModel(raw);
  return { id: id ?? 'unknown', ...(MODELS[id] ?? UNKNOWN) };
}

export function isKnownModel(raw) {
  return Boolean(MODELS[normalizeModel(raw)]);
}

export function listModels() {
  return Object.entries(MODELS).map(([id, m]) => ({ id, ...m }));
}

/**
 * Cost one usage record in USD.
 *
 * `usage` is the raw `message.usage` object from a transcript entry. Cache
 * creation is split by TTL when the record reports it, since 1h writes cost
 * 2x input rather than 1.25x.
 */
export function costOf(usage, rawModel, speed) {
  const info = modelInfo(rawModel);
  const fast = speed === 'fast' ? FAST_MODE[info.id] : null;
  const inRate = (fast?.input ?? info.input) / 1e6;
  const outRate = (fast?.output ?? info.output) / 1e6;

  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;

  const totalWrite = usage?.cache_creation_input_tokens ?? 0;
  const write1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5mReported = usage?.cache_creation?.ephemeral_5m_input_tokens;
  // If the breakdown is absent, assume the whole write used the default 5m TTL.
  const write5m = write5mReported ?? Math.max(0, totalWrite - write1h);

  const cost = {
    input: input * inRate,
    output: output * outRate,
    cacheWrite:
      write5m * inRate * CACHE_WRITE_5M_MULTIPLIER + write1h * inRate * CACHE_WRITE_1H_MULTIPLIER,
    cacheRead: cacheRead * inRate * CACHE_READ_MULTIPLIER,
  };
  cost.total = cost.input + cost.output + cost.cacheWrite + cost.cacheRead;
  return cost;
}
