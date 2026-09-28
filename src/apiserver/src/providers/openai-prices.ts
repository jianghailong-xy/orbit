/**
 * What one Responses API call cost, for the shared pool's ledger (`pool_usage.cost_micros`), which is
 * what a key's share cap is held to (docs/codex-shared-pool-design.md §2.2). OpenAI's answer counts
 * tokens and names no price, so the price is ours: US dollars per million tokens, OpenAI's published
 * standard-tier API prices.
 *
 * Only models whose price is known are listed. Any other — Codex's own current catalogue among them
 * (gpt-5.6-*, gpt-6-*), which has no published API price here — is charged FALLBACK, the dearest of the
 * non-pro models below, so that a cap errs towards stopping early rather than letting the others spend
 * past it. Replace it with the real figure once there is one.
 */
export interface OpenAIPrice {
  /** Uncached input. */
  input: number;
  /** Input served from the prompt cache. */
  cachedInput: number;
  /** Output, reasoning included. */
  output: number;
}

/** Longest prefix wins, so a dated snapshot (`gpt-5-2025-08-07`) is its model's price. */
const PRICES: ReadonlyArray<readonly [prefix: string, price: OpenAIPrice]> = [
  ['gpt-5', { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-5-mini', { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5-nano', { input: 0.05, cachedInput: 0.005, output: 0.4 }],
  ['gpt-5-codex', { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-5-pro', { input: 15, cachedInput: 15, output: 120 }],
  ['gpt-5.1', { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-5.1-codex-mini', { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5.2', { input: 1.75, cachedInput: 0.175, output: 14 }],
  ['gpt-5.2-pro', { input: 21, cachedInput: 21, output: 168 }],
  ['codex-mini-latest', { input: 1.5, cachedInput: 0.375, output: 6 }],
];

/** Charged for a model not listed above: gpt-5.2's price, the dearest of the non-pro models. */
export const FALLBACK_PRICE: OpenAIPrice = { input: 1.75, cachedInput: 0.175, output: 14 };

/**
 * What a service tier multiplies the standard price by. Codex's fast mode asks for `priority`, which
 * OpenAI bills at twice the standard rate; `flex` is half. Anything else is standard.
 */
const TIER_FACTOR: Readonly<Record<string, number>> = { priority: 2, flex: 0.5 };

/** The price of `model`, and whether it is the fallback because the model is not listed. */
export function openAIPriceOf(model: string | undefined): { price: OpenAIPrice; known: boolean } {
  const id = (model ?? '').toLowerCase();
  let best: readonly [string, OpenAIPrice] | undefined;
  for (const entry of PRICES) {
    if ((id === entry[0] || id.startsWith(`${entry[0]}-`)) && (!best || entry[0].length > best[0].length)) {
      best = entry;
    }
  }
  return best ? { price: best[1], known: true } : { price: FALLBACK_PRICE, known: false };
}

/** A Responses API `usage` object, as `response.completed` carries it. */
export interface ResponsesUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens?: number;
}

/**
 * What `usage` cost, in millionths of a dollar. Dollars per million tokens times tokens is exactly that
 * unit, so no scaling is needed: cached input at its own price, the rest of the input at the input price,
 * and every output token (reasoning included) at the output price.
 */
export function responseCostMicros(
  model: string | undefined,
  serviceTier: string | undefined,
  usage: ResponsesUsage,
): number {
  const { price } = openAIPriceOf(model);
  const input = nonNegative(usage.input_tokens);
  const cached = Math.min(input, nonNegative(usage.input_tokens_details?.cached_tokens));
  const output = nonNegative(usage.output_tokens);
  const standard = (input - cached) * price.input + cached * price.cachedInput + output * price.output;
  return Math.round(standard * (TIER_FACTOR[serviceTier ?? ''] ?? 1));
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
