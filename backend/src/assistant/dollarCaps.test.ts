// The dollar caps' sums (336_assistant_dollar_caps; docs/billing.md § Assistant dollar caps).
import { describe, expect, it } from 'vitest';
import { assistantConfig } from './config.js';
import { dayResetsAt, daysLeftInMonth, DOLLAR_REFUSAL, poolAlarmShare, poolDayAllowance } from './dollarCaps.js';
import { usdMicrosPerWeightedToken } from './pricing.js';

const POOL = 30_000_000; // $30

describe('the paced Free pool', () => {
	it('counts the days left in the UTC month, the day included', () => {
		expect(daysLeftInMonth(new Date('2026-11-01T00:00:00Z'))).toBe(30);
		expect(daysLeftInMonth(new Date('2026-11-30T23:59:59Z'))).toBe(1);
		expect(daysLeftInMonth(new Date('2028-02-01T12:00:00Z'))).toBe(29); // a leap February
	});

	it('gives a day twice its even share of what was left at its start', () => {
		// Day 1 of 30: $30 ÷ 30 × 2 = $2.
		expect(poolDayAllowance(POOL, 0, new Date('2026-11-01T08:00:00Z'))).toBe(2_000_000);
		// $27 spent before day 21 of 30: $3 ÷ 10 × 2 = $0.60.
		expect(poolDayAllowance(POOL, 27_000_000, new Date('2026-11-21T08:00:00Z'))).toBe(600_000);
		// The last day may spend everything left, twice over (the month's cap still binds in SQL).
		expect(poolDayAllowance(POOL, 29_000_000, new Date('2026-11-30T23:00:00Z'))).toBe(2_000_000);
	});

	it('gives nothing once the month is spent, never a negative share', () => {
		expect(poolDayAllowance(POOL, POOL, new Date('2026-11-10T00:00:00Z'))).toBe(0);
		expect(poolDayAllowance(POOL, POOL + 5, new Date('2026-11-10T00:00:00Z'))).toBe(0);
	});

	it('rounds a share down to a whole micro-USD', () => {
		// $1 left over 3 days: 666 666.66… → 666 666.
		expect(poolDayAllowance(1_000_000, 0, new Date('2026-11-28T00:00:00Z'))).toBe(666_666);
	});

	it('turns over at UTC midnight and on the first of the month', () => {
		// 23:59 UTC on 31 October is still October's last day: one day left.
		expect(poolDayAllowance(POOL, 0, new Date('2026-10-31T23:59:59Z'))).toBe(60_000_000);
		expect(poolDayAllowance(POOL, 0, new Date('2026-11-01T00:00:00Z'))).toBe(2_000_000);
		expect(dayResetsAt(new Date('2026-10-31T23:59:59Z'))).toBe('2026-11-01T00:00:00.000Z');
	});

	it('names the alarm threshold the month has passed', () => {
		expect(poolAlarmShare(14_999_999, POOL)).toBeNull();
		expect(poolAlarmShare(15_000_000, POOL)).toBe(50);
		expect(poolAlarmShare(24_000_000, POOL)).toBe(80);
		expect(poolAlarmShare(31_000_000, POOL)).toBe(80);
		expect(poolAlarmShare(null, POOL)).toBeNull();
		expect(poolAlarmShare(10, null)).toBeNull();
		expect(poolAlarmShare(10, 0)).toBeNull();
	});
});

describe('the dearest price of a weighted token', () => {
	it('is the greatest of input, cache write and output ÷ 5', () => {
		// Sonnet 5.5: input 2, cache write 2.5, output 10 ÷ 5 = 2 → 2.5 micro-USD a weighted token.
		expect(usdMicrosPerWeightedToken('bedrock', 'global.anthropic.claude-sonnet-5-5-v1:0')).toBe(2.5);
		// Haiku 4.5: 1, 1.25, 1 → 1.25.
		expect(usdMicrosPerWeightedToken('bedrock', 'anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(1.25);
	});

	it('bounds any turn of that many weighted tokens', async () => {
		const { costUsdMicros, MODEL_PRICES } = await import('./pricing.js');
		for (const [model, price] of Object.entries(MODEL_PRICES)) {
			const per = usdMicrosPerWeightedToken('bedrock', model)!;
			// All input written to the cache, or all output: the dearest mixes.
			expect(costUsdMicros(price, { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10_000 })).toBeLessThanOrEqual(Math.ceil(10_000 * per));
			expect(costUsdMicros(price, { inputTokens: 0, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeLessThanOrEqual(Math.ceil(10_000 * per));
		}
	});

	it('is 0 for a local model and null for one with no price', () => {
		expect(usdMicrosPerWeightedToken('mock', '')).toBe(0);
		expect(usdMicrosPerWeightedToken('ollama', 'llama')).toBe(0);
		expect(usdMicrosPerWeightedToken('bedrock', 'arn:aws:bedrock:af-south-1:1:application-inference-profile/x')).toBeNull();
	});
});

describe('the dollar caps’ settings and words', () => {
	it('defaults to the issue’s figures: $0.30 or 20 messages a Free day, a $30 pool', () => {
		expect(assistantConfig({})).toMatchObject({ freeUsdMicrosPerDay: 300_000, freeMessagesPerDay: 20, poolUsdMicrosPerMonth: 30_000_000 });
		expect(
			assistantConfig({ ASSISTANT_FREE_USD_PER_DAY: '0.5', ASSISTANT_FREE_MESSAGES_PER_DAY: '5', ASSISTANT_FREE_POOL_USD_PER_MONTH: '100' })
		).toMatchObject({ freeUsdMicrosPerDay: 500_000, freeMessagesPerDay: 5, poolUsdMicrosPerMonth: 100_000_000 });
		// Nonsense falls back.
		expect(assistantConfig({ ASSISTANT_FREE_USD_PER_DAY: '-1', ASSISTANT_FREE_POOL_USD_PER_MONTH: 'lots' })).toMatchObject({
			freeUsdMicrosPerDay: 300_000,
			poolUsdMicrosPerMonth: 30_000_000
		});
	});

	it('words each refusal with a stable code, the pool one with no upgrade prompt', () => {
		expect(Object.values(DOLLAR_REFUSAL).map((r) => r.code)).toEqual(['assistant_daily_cap', 'assistant_monthly_cap', 'assistant_member_cap', 'assistant_free_pool_spent']);
		expect(DOLLAR_REFUSAL.month.message('2026-12-01T00:00:00.000Z')).toContain('1 December');
		expect(DOLLAR_REFUSAL.pool.message('')).toContain('This isn’t something you did');
		expect(DOLLAR_REFUSAL.pool.message('')).not.toMatch(/Pro|plan/);
	});
});
