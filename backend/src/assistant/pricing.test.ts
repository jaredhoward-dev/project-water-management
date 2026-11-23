// A turn's cost in micro-USD from the per-model price table (pricing.ts; issue #641 Phase 1).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { costUsdMicros, MODEL_PRICES, modelPrice, pricedModelId, turnCostUsdMicros, type TurnTokens } from './pricing.js';
import { ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic.js';
import { turnModel } from './routes.js';

const SONNET_55 = MODEL_PRICES['claude-sonnet-5-5']!;
const none: TurnTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const tokens = (t: Partial<TurnTokens>): TurnTokens => ({ ...none, ...t });

describe('the price table', () => {
	it('has Sonnet 5.5 at the recorded Bedrock price: $2 in, $10 out, $0.10 cache read, $2.50 cache write a million', () => {
		expect(SONNET_55).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
	});

	it('prices every model with output at 5 × input and a cache write at 1.25 × input, below input for a read', () => {
		for (const [id, p] of Object.entries(MODEL_PRICES)) {
			expect(p.output, id).toBeCloseTo(5 * p.input, 10);
			expect(p.cacheWrite, id).toBeCloseTo(1.25 * p.input, 10);
			expect(p.cacheRead, id).toBeLessThan(p.input);
			// Whole millionths of a micro-USD a token, so the sum is exact before its one rounding.
			for (const usd of Object.values(p)) expect(Math.abs(usd * 1e6 - Math.round(usd * 1e6)), `${id} ${usd}`).toBeLessThan(1e-6);
		}
	});

	it('prices the models production and the dev providers call by default (an unpriced default fails here)', () => {
		const tf = readFileSync(new URL('../../../infra/variables.tf', import.meta.url), 'utf8');
		const infraDefault = /variable "assistant_model_id" \{[\s\S]*?default\s*=\s*"([^"]+)"/.exec(tf)?.[1];
		expect(infraDefault).toBeTruthy();
		for (const model of [infraDefault!, ANTHROPIC_DEFAULT_MODEL, turnModel({ provider: 'anthropic', model: '' })]) expect(modelPrice(model), model).not.toBeNull();
	});
});

describe('pricedModelId', () => {
	it('reads every form ASSISTANT_MODEL takes as the same model', () => {
		for (const id of [
			'claude-sonnet-5-5',
			'anthropic.claude-sonnet-5-5',
			'global.anthropic.claude-sonnet-5-5',
			'eu.anthropic.claude-sonnet-5-5',
			'anthropic.claude-sonnet-5-5-v1:0',
			'us.anthropic.claude-sonnet-5-5-20260901-v1:0',
			' claude-sonnet-5-5 '
		])
			expect(pricedModelId(id), id).toBe('claude-sonnet-5-5');
	});

	it('has no price for an unknown model or an application profile ARN, which names no model', () => {
		expect(modelPrice('global.anthropic.claude-opus-5-5')).toBeNull();
		expect(modelPrice('arn:aws:bedrock:af-south-1:000000000000:application-inference-profile/abc123')).toBeNull();
		expect(modelPrice('')).toBeNull();
	});
});

describe('costUsdMicros', () => {
	it('prices each kind of token at its own rate: a token at $p a million costs p micro-USD', () => {
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 1_000_000 }))).toBe(2_000_000);
		expect(costUsdMicros(SONNET_55, tokens({ outputTokens: 1_000_000 }))).toBe(10_000_000);
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }))).toBe(100_000);
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }))).toBe(2_500_000);
	});

	it('prices the cache apart from the rest of the input (input counts the cache tokens too)', () => {
		// 77k input of which 60k read and 10k written, and 2.6k output: 7k × 2 + 60k × 0.1 + 10k × 2.5 + 2.6k × 10.
		const t = tokens({ inputTokens: 77_000, cacheReadTokens: 60_000, cacheWriteTokens: 10_000, outputTokens: 2_600 });
		expect(costUsdMicros(SONNET_55, t)).toBe(14_000 + 6_000 + 25_000 + 26_000);
		// The same tokens uncached cost more: the cache is not priced as plain input.
		expect(costUsdMicros(SONNET_55, { ...t, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(154_000 + 26_000);
	});

	it('rounds a fraction of a micro-USD up, once a turn: anything spent is never 0', () => {
		expect(costUsdMicros(SONNET_55, none)).toBe(0);
		// One cache read at $0.10 a million is 0.1 micro-USD.
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 1, cacheReadTokens: 1 }))).toBe(1);
		// 15 reads: 1.5 → 2; 10 reads: exactly 1, not rounded past.
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 15, cacheReadTokens: 15 }))).toBe(2);
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 10, cacheReadTokens: 10 }))).toBe(1);
		// Haiku 5.5's cache read ($0.01 a million): a hundred reads make one micro-USD.
		expect(costUsdMicros(MODEL_PRICES['claude-haiku-5-5']!, tokens({ inputTokens: 100, cacheReadTokens: 100 }))).toBe(1);
	});

	it('never prices more cache than input, nor a negative or fractional count', () => {
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 10, cacheReadTokens: 50 }))).toBe(1);
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 50 }))).toBe(Math.ceil(0.6 + 4 * 2.5));
		expect(costUsdMicros(SONNET_55, tokens({ inputTokens: -5, outputTokens: 2.4 }))).toBe(20);
	});
});

describe('turnCostUsdMicros', () => {
	const t = tokens({ inputTokens: 1_000, outputTokens: 100 });
	it('prices a hosted model from the table and returns null for one it lacks', () => {
		expect(turnCostUsdMicros('bedrock', 'global.anthropic.claude-sonnet-5-5', t)).toBe(3_000);
		expect(turnCostUsdMicros('anthropic', turnModel({ provider: 'anthropic', model: '' }), t)).toBe(3_000);
		expect(turnCostUsdMicros('bedrock', 'global.anthropic.claude-unknown-9', t)).toBeNull();
	});

	it('costs nothing on the local providers', () => {
		expect(turnCostUsdMicros('mock', '', t)).toBe(0);
		expect(turnCostUsdMicros('ollama', 'qwen2.5-coder:7b', t)).toBe(0);
	});
});
