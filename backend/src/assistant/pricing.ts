// What a turn of the assistant costs, in micro-USD (issue #641 Phase 1,
// shadow mode: recorded on the turn's usage row, 324_assistant_turn_cost.sql;
// no cap reads it yet). The caps still count weighted tokens (config.ts).
//
// Each model's price per million tokens, in USD: input, output, cache reads
// and cache writes, each priced apart. The prices are Amazon Bedrock's for
// the global cross-region inference profile called from af-south-1, which is
// how production reaches Claude (docs/deployment.md § The assistant):
//   - input, output and cache reads: AWS Price List API,
//     AmazonBedrockFoundationModels, af-south-1, global usage types,
//     publication 2026-10-12 (issue #641's model price table;
//     infra/variables.tf assistant_input_usd_per_million for Sonnet 5.5);
//   - cache writes: Sonnet 5.5's $2.50 is recorded with the same read
//     (infra/variables.tf); the others are 1.25 × input, the price of a
//     5-minute cache write (the only kind the providers ask for: a Bedrock
//     `cachePoint` and the Anthropic API's `ephemeral`), Anthropic's
//     prompt-caching rule, which Sonnet 5.5's recorded price follows.
// A model not in the table has no price: its turns are recorded as unpriced
// (counted, not guessed). Add a model here, from a dated price read, before
// assistant_model_id names it. The local providers (mock, ollama) cost
// nothing. The anthropic provider (dev only, its own key) is priced from the
// same table, so its figures are Bedrock's, not the Anthropic API's bill,
// and a server-side fallback's attempts are priced as the model asked for.
// Every price is the flat one: the Anthropic API's long-prompt rate for
// Haiku 5.5 (past 100K input tokens a call) has no Bedrock row in the read
// above; a call passes 100K only near ASSISTANT_MAX_TURN_TOKENS (150K
// weighted, the whole turn). Re-read the tiers before Haiku 5.5 runs here.
import type { AssistantProviderName } from './types.js';

/** USD per million tokens of each kind. */
export interface ModelPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** By model id with no Bedrock prefix or version suffix (pricedModelId). */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
	'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
};

/**
 * The table's key for a model id as ASSISTANT_MODEL names it: a Bedrock id
 * (`anthropic.claude-…`), a system inference profile (`global.anthropic.…`,
 * `eu.anthropic.…`), with or without a date and a `-v1:0` version, or the
 * Anthropic API's own id. An application inference profile's ARN doesn't
 * name its model, so it is returned as is (and has no price).
 */
export function pricedModelId(model: string): string {
	return model
		.trim()
		.replace(/^([a-z]+\.)?anthropic\./, '')
		.replace(/-v\d+(:\d+)?$/, '')
		.replace(/-\d{8}$/, '');
}

/** The model's price, or null when the table has none. */
export function modelPrice(model: string): ModelPrice | null {
	return MODEL_PRICES[pricedModelId(model)] ?? null;
}

/** A turn's tokens as the orchestrator counts them: inputTokens includes the cache reads and writes. */
export interface TurnTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

const count = (n: number) => Math.max(0, Math.round(n) || 0);

/**
 * The turn's cost in whole micro-USD at `price`: uncached input, output,
 * cache reads and cache writes each at their own rate. A token at $p per
 * million costs p micro-USD, so the exact cost is Σ tokens × p; it is summed
 * in integer millionths of a micro-USD (every table price is a whole number of
 * those) and rounded up once, so a turn that spent anything never records 0
 * and the sum over turns is never short (each turn overstates by under one
 * micro-USD).
 */
export function costUsdMicros(price: ModelPrice, t: TurnTokens): number {
	const input = count(t.inputTokens);
	const cacheRead = Math.min(input, count(t.cacheReadTokens));
	const cacheWrite = Math.min(input - cacheRead, count(t.cacheWriteTokens));
	const uncached = input - cacheRead - cacheWrite;
	const per = (usd: number) => Math.round(usd * 1e6);
	const pico = uncached * per(price.input) + count(t.outputTokens) * per(price.output) + cacheRead * per(price.cacheRead) + cacheWrite * per(price.cacheWrite);
	return Math.ceil(pico / 1e6);
}

/**
 * What the turn cost in micro-USD with this provider and the model it called
 * (routes.ts turnModel resolves an empty ASSISTANT_MODEL to the provider's
 * default), or null when the model has no price.
 */
export function turnCostUsdMicros(provider: Exclude<AssistantProviderName, 'off'>, model: string, t: TurnTokens): number | null {
	if (provider === 'mock' || provider === 'ollama') return 0;
	const price = modelPrice(model);
	return price ? costUsdMicros(price, t) : null;
}

/**
 * The most a weighted token (config.ts weightedTokens: input + 5 × output) can
 * cost with this model, in micro-USD: the greatest of the input, cache-write
 * and output ÷ 5 prices. A turn's token budget × this bounds its cost, so the
 * dollars app_assistant_begin reserves are never short
 * (336_assistant_dollar_caps). 0 for the local providers, null with no price.
 */
export function usdMicrosPerWeightedToken(provider: Exclude<AssistantProviderName, 'off'>, model: string): number | null {
	if (provider === 'mock' || provider === 'ollama') return 0;
	const price = modelPrice(model);
	return price ? Math.max(price.input, price.cacheWrite, price.output / 5) : null;
}
