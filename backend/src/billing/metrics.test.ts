// The Phase 1 metrics' maths (src/billing/metrics.ts, issue #641): canonical
// addresses, percentiles, activation, the Free limit shares, spend per plan,
// the new-account spend share, clusters, and that the default output holds
// no address. The rows are synthetic; 325's functions are tested in
// metrics.db.test.ts.
import { describe, expect, it } from 'vitest';
import {
	abuseReport, activation, busiestWeek, buildReport, canonicalEmail, formatReport, freeLimitShares, gateRefusals, heaviestFree, newAccountFreeSpend,
	NOT_YET_MEASURABLE, percentile, redact, spendByPlan, type AccountRow, type PersonRow
} from './metrics.js';

const t = (iso: string) => new Date(iso);
const acct = (o: Partial<AccountRow> & { accountId: string }): AccountRow => ({
	kind: 'user', planCode: 'free', startedAt: t('2026-01-01T00:00:00Z'), catchments: 1, runs: 0, reports: 0, assistantUsdMicros: 0, unpricedTurns: 0,
	lastSpendAt: null, ...o
});
const person = (o: Partial<PersonRow> & { userId: string; email: string }): PersonRow => ({
	createdAt: t('2026-11-02T08:00:00Z'), verified: true, firstRunAt: null, inMonth: true, signupDay: '2026-11-02', ...o
});
const FREE = { catchments: null, reports_per_month: 5, assistant_usd_micros_per_month: 1_000_000 };

describe('canonicalEmail', () => {
	it('lower-cases, drops a +tag, and for Gmail the dots too', () => {
		expect(canonicalEmail(' A.B+x@Example.com ')).toBe('a.b@example.com');
		expect(canonicalEmail('a.b.c+promo@gmail.com')).toBe('abc@gmail.com');
		expect(canonicalEmail('a.b@googlemail.com')).toBe('ab@gmail.com');
		expect(canonicalEmail('a.b@example.org')).toBe('a.b@example.org');
	});
});

describe('percentile', () => {
	it('is nearest-rank, and null for no values', () => {
		expect(percentile([], 0.5)).toBeNull();
		expect(percentile([5], 0.9)).toBe(5);
		expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
	});
});

describe('activation', () => {
	const now = t('2026-11-20T00:00:00Z');
	it('counts verified sign-ups of the month with a run within 7 days, leaving out the ones whose window is still open', () => {
		const a = activation(
			[
				person({ userId: 'u1', email: 'a@x.test', firstRunAt: t('2026-11-03T00:00:00Z') }),
				person({ userId: 'u2', email: 'b@x.test', firstRunAt: t('2026-11-09T08:00:00Z') }), // exactly 7 days: counts
				person({ userId: 'u3', email: 'c@x.test', firstRunAt: t('2026-11-09T08:00:01Z') }), // a second late
				person({ userId: 'u4', email: 'd@x.test' }), // never ran
				person({ userId: 'u5', email: 'e@x.test', createdAt: t('2026-11-15T00:00:00Z') }), // under 7 days old: pending
				person({ userId: 'u6', email: 'f@x.test', verified: false, firstRunAt: t('2026-11-03T00:00:00Z') }),
				person({ userId: 'u7', email: 'g@x.test', inMonth: false, firstRunAt: t('2026-10-03T00:00:00Z') })
			],
			now
		);
		expect(a).toEqual({ cohort: 4, activated: 2, share: 0.5, pending: 1, unverified: 1 });
	});

	it('has no share without a cohort', () => {
		expect(activation([], now).share).toBeNull();
	});
});

describe('freeLimitShares', () => {
	it('counts active Free accounts near (≥ 80%) and at each limit; Free has no catchment limit', () => {
		const r = freeLimitShares(
			[
				acct({ accountId: 'a', runs: 1, reports: 4, assistantUsdMicros: 800_000 }), // near both
				acct({ accountId: 'b', reports: 5, assistantUsdMicros: 1_200_000 }), // at both
				acct({ accountId: 'c', runs: 3, reports: 3, assistantUsdMicros: 100 }), // neither
				acct({ accountId: 'd', runs: 2 }), // active, nothing used
				acct({ accountId: 'e', reports: 9 }), // inactive? no: a report is activity
				acct({ accountId: 'f' }), // inactive: left out
				acct({ accountId: 'g', planCode: 'pro', reports: 50, runs: 1 }) // not Free
			],
			FREE
		);
		expect(r.active).toBe(5);
		expect(r.limits).toEqual([
			{ limit: 'reports_per_month', value: 5, near: 1, at: 2, nearShare: 0.2, atShare: 0.4 },
			{ limit: 'assistant_usd_micros_per_month', value: 1_000_000, near: 1, at: 1, nearShare: 0.2, atShare: 0.2 },
			{ limit: 'catchments', value: null, near: 0, at: 0, nearShare: null, atShare: null }
		]);
	});
});

describe('spend', () => {
	const rows = [
		acct({ accountId: 'a', assistantUsdMicros: 100 }),
		acct({ accountId: 'b', assistantUsdMicros: 300 }),
		acct({ accountId: 'c', assistantUsdMicros: 200, unpricedTurns: 2 }),
		acct({ accountId: 'd' }),
		acct({ accountId: 'e', planCode: 'pro', assistantUsdMicros: 9_000_000 })
	];

	it('gives p50 and p90 per plan over the accounts that spent, and flags unpriced turns', () => {
		expect(spendByPlan(rows)).toEqual([
			{ plan: 'free', spenders: 3, p50UsdMicros: 200, p90UsdMicros: 300, totalUsdMicros: 600, unpricedTurns: 2 },
			{ plan: 'pro', spenders: 1, p50UsdMicros: 9_000_000, p90UsdMicros: 9_000_000, totalUsdMicros: 9_000_000, unpricedTurns: 0 }
		]);
	});

	it('lists the heaviest Free spenders first', () => {
		expect(heaviestFree(rows, 2)).toEqual([
			{ accountId: 'b', usdMicros: 300 },
			{ accountId: 'c', usdMicros: 200 }
		]);
	});

	it('shares Free spend by accounts whose latest spend came under 7 days after they started', () => {
		const r = newAccountFreeSpend([
			acct({ accountId: 'n', startedAt: t('2026-11-10T00:00:00Z'), lastSpendAt: t('2026-11-16T23:59:59Z'), assistantUsdMicros: 300 }),
			acct({ accountId: 'o', startedAt: t('2026-11-10T00:00:00Z'), lastSpendAt: t('2026-11-17T00:00:00Z'), assistantUsdMicros: 700 }),
			acct({ accountId: 'p', planCode: 'pro', startedAt: t('2026-11-10T00:00:00Z'), lastSpendAt: t('2026-11-11T00:00:00Z'), assistantUsdMicros: 5000 })
		]);
		expect(r).toEqual({ totalUsdMicros: 1000, newUsdMicros: 300, share: 0.3 });
		expect(newAccountFreeSpend([]).share).toBeNull();
	});
});

describe('abuse signals', () => {
	it('finds the busiest 7 days', () => {
		expect(busiestWeek([])).toEqual({ count: 0, from: null });
		expect(busiestWeek(['2026-11-01', '2026-11-07', '2026-11-08', '2026-11-08', '2026-11-20'])).toEqual({ count: 3, from: '2026-11-07' });
		// Across a month's end.
		expect(busiestWeek(['2026-10-30', '2026-11-02', '2026-11-05'])).toEqual({ count: 3, from: '2026-10-30' });
	});

	const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
	const people: PersonRow[] = [
		...days.map((d, i) => person({ userId: `burst${i}`, email: `x${i}@burst.test`, signupDay: d })),
		...days.slice(0, 4).map((d, i) => person({ userId: `quiet${i}`, email: `q${i}@quiet.test`, signupDay: d })),
		person({ userId: 'g1', email: 'farm.er@gmail.com', createdAt: t('2026-10-01T00:00:00Z'), inMonth: false, signupDay: '2026-10-01' }),
		person({ userId: 'g2', email: 'Farmer+2@gmail.com', signupDay: '2026-11-03', createdAt: t('2026-11-03T00:00:00Z') }),
		person({ userId: 'old1', email: 'a@old.test', inMonth: false }),
		person({ userId: 'old2', email: 'a+b@old.test', inMonth: false })
	];

	it('counts sign-ups per day, finds domains with 5+ in 7 days, and canonical addresses with several accounts', () => {
		const r = abuseReport(people);
		expect(r.signupsPerDay.find((d) => d.day === '2026-11-03')).toEqual({ day: '2026-11-03', signups: 3 });
		expect(r.domainClusters).toEqual([{ domain: 'burst.test', signups: 5, busiestWeek: 5, weekFrom: '2026-11-01', commonProvider: false }]);
		// The old.test pair has no sign-up this month, so it was reported before.
		expect(r.canonicalClusters).toEqual([{ canonical: 'farmer@gmail.com', userIds: ['g1', 'g2'], inMonth: 1, emails: ['farm.er@gmail.com', 'Farmer+2@gmail.com'] }]);
	});

	it('prints no address unless asked, in the text and in the JSON', () => {
		const report = buildReport('2026-11', t('2026-11-20T00:00:00Z'), [acct({ accountId: 'a', runs: 1 })], people, FREE);
		const text = formatReport(redact(report), false);
		const json = JSON.stringify(redact(report));
		for (const out of [text, json]) {
			expect(out).not.toMatch(/farm\.er@|Farmer\+2@|farmer@gmail/);
			expect(out).toContain('g1');
		}
		expect(formatReport(report, true)).toContain('farm.er@gmail.com');
		expect(text).toContain('Not yet measurable');
		expect(text).toContain('Upgrade at the limit');
	});
});

describe('gateRefusals (348: the verified-email gate)', () => {
	it('sums the month by code and feature, and reports zero for none', () => {
		const g = gateRefusals([
			{ code: 'email_disposable', feature: 'assistant', refusals: 3 },
			{ code: 'email_disposable', feature: 'feeds', refusals: 2 },
			{ code: 'email_unverified', feature: 'assistant', refusals: 7 }
		]);
		expect(g).toEqual({ disposable: { assistant: 3, feeds: 2, total: 5 }, unverified: { assistant: 7, feeds: 0, total: 7 } });
		expect(gateRefusals([])).toEqual({ disposable: { assistant: 0, feeds: 0, total: 0 }, unverified: { assistant: 0, feeds: 0, total: 0 } });
	});

	it('prints the disposable-domain refusals as measured, no longer as a gap', () => {
		const report = buildReport('2026-11', t('2026-11-20T00:00:00Z'), [], [], {}, [{ code: 'email_disposable', feature: 'feeds', refusals: 4 }]);
		const text = formatReport(report, false);
		expect(text).toContain('disposable-domain refusals by the verified-email gate: 4 (assistant 0, feeds 4)');
		expect(text).toContain('unverified-email refusals by the same gate: 0');
		expect(NOT_YET_MEASURABLE.map((m) => m.metric)).not.toContain('Disposable-domain rejections');
		expect(text.slice(text.indexOf('Not yet measurable'))).not.toMatch(/Disposable-domain/i);
	});
});
