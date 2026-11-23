import { describe, expect, it } from 'vitest';
import type { AccountPlan, Subscription } from '#lib/api/types.js';
import { fmtPrice, fmtUsdMicros, monthName, priceLine, subscriptionLine, usageRows } from './plan';

const NB = ' ';
const TS = ' ';

function plan(over: Partial<AccountPlan> = {}): AccountPlan {
	return {
		account: { id: 'a1', kind: 'user' },
		plan: {
			code: 'free',
			name: 'Free',
			priceMonthlyMinor: 0,
			priceAnnualMinor: 0,
			currency: 'ZAR',
			limits: { catchments: null, reports_per_month: 5, packs_included_per_month: 0, assistant_usd_micros_per_month: 1_000_000, assistant_usd_micros_per_seat_month: null },
			features: {}
		},
		subscription: null,
		usage: {
			month: '2026-11',
			catchments: { used: 3, limit: null },
			reports: { used: 3, limit: 5 },
			packsIssued: { used: 1, limit: 0 },
			assistantTokens: { used: 12_345, limit: null }
		},
		enforced: false,
		...over
	};
}

const sub = (s: Partial<Subscription>): Subscription => ({
	status: 'active',
	seats: 1,
	periodStart: '2026-11-01T00:00:00Z',
	periodEnd: '2026-12-01',
	trialEnd: null,
	cancelAtPeriodEnd: false,
	...s
});

describe('fmtPrice', () => {
	it('reads ZAR cents as rand with two decimals, held to the R', () => {
		expect(fmtPrice(89_900, 'ZAR')).toBe(`R${NB}899.00`);
		expect(fmtPrice(2_499_000, 'ZAR')).toBe(`R${NB}24${TS}990.00`);
	});
	it('names any other currency by its code', () => {
		expect(fmtPrice(1_500, 'USD')).toBe(`USD${NB}15.00`);
	});
	it('says nothing at all is no charge', () => {
		expect(fmtPrice(0, 'ZAR')).toBe('No charge');
	});
});

describe('priceLine', () => {
	it('gives the month and the year', () => {
		const p = { ...plan().plan, code: 'pro' as const, name: 'Pro', priceMonthlyMinor: 89_900, priceAnnualMinor: 899_000 };
		expect(priceLine(p)).toBe(`R${NB}899.00 a month or R${NB}8${TS}990.00 a year`);
	});
	it('leaves out a year with no annual price, and Free is no charge', () => {
		expect(priceLine({ ...plan().plan, priceMonthlyMinor: 100 })).toBe(`R${NB}1.00 a month`);
		expect(priceLine(plan().plan)).toBe('No charge');
	});
});

describe('monthName', () => {
	it('names the month', () => {
		expect(monthName('2026-11')).toBe('November 2026');
		expect(monthName('2027-01')).toBe('January 2027');
	});
	it('leaves anything else alone', () => {
		expect(monthName('2026-13')).toBe('2026-13');
		expect(monthName('soon')).toBe('soon');
	});
});

describe('subscriptionLine', () => {
	it('is nothing on Free (no subscription)', () => {
		expect(subscriptionLine(null)).toBeNull();
	});
	it('gives the renewal day, or the end when it won’t renew', () => {
		expect(subscriptionLine(sub({}))).toEqual({ text: 'Renews 1 Dec 2026', warn: false });
		expect(subscriptionLine(sub({ cancelAtPeriodEnd: true }))).toEqual({ text: 'Ends 1 Dec 2026; it won\'t renew', warn: true });
	});
	it('gives the trial’s end', () => {
		expect(subscriptionLine(sub({ status: 'trialing', trialEnd: '2026-12-07' }))).toEqual({ text: 'Trial ends 7 Dec 2026', warn: false });
	});
	it('flags past due, cancelled and expired', () => {
		expect(subscriptionLine(sub({ status: 'past_due' }))).toEqual({ text: 'Payment overdue', warn: true });
		expect(subscriptionLine(sub({ status: 'canceled' }))?.warn).toBe(true);
		expect(subscriptionLine(sub({ status: 'expired', periodEnd: null }))).toEqual({ text: 'Expired', warn: true });
	});
});

describe('usageRows', () => {
	const rows = usageRows(plan());
	const by = (k: string) => rows.find((r) => r.key === k)!;

	it('keeps the order: catchments, reports, packs, assistant', () => {
		expect(rows.map((r) => r.key)).toEqual(['catchments', 'reports', 'packsIssued', 'assistantTokens']);
		expect(by('reports').label).toBe('Reports in November 2026');
	});
	it('says Unlimited and draws no bar where the limit is null', () => {
		expect(by('catchments')).toMatchObject({ figures: '3 used', status: 'Unlimited', fraction: null, over: false });
	});
	it('counts what is left against a limit', () => {
		expect(by('reports')).toMatchObject({ figures: '3 of 5', status: '2 left', fraction: 0.6, over: false });
		expect(usageRows(plan({ usage: { ...plan().usage, reports: { used: 5, limit: 5 } } }))[1]!.status).toBe('At the limit');
	});
	it('says how far over a limit the count is (shadow mode: counted, not refused), the bar full', () => {
		expect(by('packsIssued')).toMatchObject({ figures: '1 of 0', status: '1 over the limit', fraction: 1, over: true });
		const over = usageRows(plan({ usage: { ...plan().usage, reports: { used: 8, limit: 5 } } }))[1]!;
		expect(over).toMatchObject({ status: '3 over the limit', fraction: 1, over: true });
	});
	it('an empty bar at a zero limit with nothing used', () => {
		expect(usageRows(plan({ usage: { ...plan().usage, packsIssued: { used: 0, limit: 0 } } }))[2]!).toMatchObject({ fraction: 0, status: 'At the limit', over: false });
	});
	it('says the assistant is capped by cost, a month or per seat', () => {
		expect(by('assistantTokens')).toMatchObject({ figures: `12${TS}345 used`, status: 'Unlimited' });
		expect(by('assistantTokens').note).toBe('Capped by cost, not tokens: $1.00 of assistant use a month.');
		const team = plan();
		team.plan = { ...team.plan, limits: { ...team.plan.limits, assistant_usd_micros_per_month: null, assistant_usd_micros_per_seat_month: 15_000_000 } };
		expect(usageRows(team)[3]!.note).toBe('Capped by cost, not tokens: $15.00 of assistant use per seat a month.');
		team.plan = { ...team.plan, limits: {} };
		expect(usageRows(team)[3]!.note).toBeNull();
	});
	it('fmtUsdMicros reads millionths of a dollar', () => {
		expect(fmtUsdMicros(1_500_000)).toBe('$1.50');
	});
});
