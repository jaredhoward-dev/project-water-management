import { describe, expect, it } from 'vitest';
import type { AccountPlan, Subscription } from '#lib/api/types.js';
import { CONFIRM_DELAYS_MS, billingActions, checkoutNotice, fmtPrice, fmtUsdMicros, monthName, priceLine, shadowNote, subscriptionLine, upgradeLabel, usageRows } from './plan';

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
			assistantTokens: { used: 12_345, limit: null },
			assistantCost: { usedUsdMicros: 420_000, limitUsdMicros: 1_000_000, unpricedTurns: 0 }
		},
		enforced: false,
		provider: 'mock',
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
	const withUsage = (u: Partial<AccountPlan['usage']>) => usageRows(plan({ usage: { ...plan().usage, ...u } }));

	it('keeps the order: catchments, reports, packs, assistant', () => {
		expect(rows.map((r) => r.key)).toEqual(['catchments', 'reports', 'packsIssued', 'assistantCost']);
		expect(by('reports').label).toBe('Reports in November 2026');
	});
	it('says Unlimited and draws no bar where the limit is null', () => {
		expect(by('catchments')).toMatchObject({ figures: '3 used', status: 'Unlimited', fraction: null, over: false });
	});
	it('counts every catchment billed to the account (there is no archived state to leave out)', () => {
		expect(by('catchments').note).toBe('Every catchment billed to this account counts, whoever made it.');
		expect(by('catchments').note).not.toMatch(/archiv/i);
	});
	it('counts what is left against a limit', () => {
		expect(by('reports')).toMatchObject({ figures: '3 of 5', status: '2 left', fraction: 0.6, over: false });
		expect(withUsage({ reports: { used: 5, limit: 5 } })[1]!.status).toBe('At the limit');
	});
	it('says how far over a limit the count is (shadow mode: counted, not refused), the bar full', () => {
		const over = withUsage({ reports: { used: 8, limit: 5 } })[1]!;
		expect(over).toMatchObject({ status: '3 over the limit', fraction: 1, over: true });
	});
	it('a zero limit is not included in the plan: no bar, never "0 of 0" or "At the limit"', () => {
		expect(withUsage({ packsIssued: { used: 0, limit: 0 } })[2]!).toMatchObject({
			figures: 'Not included in Free',
			status: null,
			fraction: null,
			over: false
		});
		expect(by('packsIssued')).toMatchObject({ figures: '1 issued; not included in Free', status: null, fraction: null, over: true });
		expect(withUsage({ reports: { used: 2, limit: 0 } })[1]!.figures).toBe('2 made; not included in Free');
	});
	it('shows the assistant as dollars used of the dollar limit, with a bar, by the UTC month', () => {
		expect(by('assistantCost')).toMatchObject({
			label: 'Assistant use in November 2026',
			used: 420_000,
			limit: 1_000_000,
			figures: '$0.42 of $1.00',
			status: '$0.58 left',
			fraction: 0.42,
			over: false
		});
		expect(by('assistantCost').note).toBe('Counted by the UTC month, which starts at 02:00 South African time on the 1st.');
		expect(rows.some((r) => r.status === 'Unlimited' && r.key === 'assistantCost')).toBe(false);
	});
	it('says when some assistant turns are unpriced, and how far over its dollars it went', () => {
		const r = withUsage({ assistantCost: { usedUsdMicros: 1_100_000, limitUsdMicros: 1_000_000, unpricedTurns: 3 } })[3]!;
		expect(r).toMatchObject({ figures: '$1.10 of $1.00', status: '$0.10 over the limit', fraction: 1, over: true });
		expect(r.note).toMatch(/^Some turns unpriced \(3\), so the true cost is higher\. Counted by the UTC month/);
	});
	it('an assistant with no dollar limit reads dollars used, with no bar', () => {
		expect(withUsage({ assistantCost: { usedUsdMicros: 2_500_000, limitUsdMicros: null, unpricedTurns: 0 } })[3]!).toMatchObject({
			figures: '$2.50 used',
			status: 'Unlimited',
			fraction: null
		});
	});
	it('fmtUsdMicros reads millionths of a dollar', () => {
		expect(fmtUsdMicros(1_500_000)).toBe('$1.50');
	});
});

describe('billingActions (Phase 3)', () => {
	it('offers nothing with the manual provider or none', () => {
		expect(billingActions(plan({ provider: 'manual' }))).toEqual({ upgrade: null, manage: false });
		expect(billingActions(plan({ provider: null }))).toEqual({ upgrade: null, manage: false });
	});
	it('offers Pro to a person and Team to a team while there is no subscription', () => {
		expect(billingActions(plan())).toEqual({ upgrade: { code: 'pro', name: 'Pro' }, manage: false });
		expect(billingActions(plan({ provider: 'stripe', account: { id: 't', kind: 'team' } }))).toEqual({ upgrade: { code: 'team', name: 'Team' }, manage: false });
	});
	it('offers Manage billing, not Upgrade, once there is a subscription', () => {
		expect(billingActions(plan({ subscription: sub({}) }))).toEqual({ upgrade: null, manage: true });
	});
});

describe('checkoutNotice', () => {
	it('words the return from checkout, and nothing for anything else', () => {
		expect(checkoutNotice('done')).toEqual({ text: 'Thank you: the payment went through.', done: true });
		expect(checkoutNotice('cancelled')).toEqual({ text: 'Checkout was cancelled. Nothing was charged.', done: false });
		expect(checkoutNotice(null)).toBeNull();
		expect(checkoutNotice('<script>')).toBeNull();
	});
	it('says it is waiting while the provider hasn’t confirmed, then to reload if it never does', () => {
		expect(checkoutNotice('done', 'waiting')?.text).toBe('Thank you: the payment went through. Waiting for the payment provider to confirm…');
		expect(checkoutNotice('done', 'unconfirmed')?.text).toContain('hasn’t confirmed it yet. Reload the page in a minute.');
		// A cancelled checkout has nothing to confirm.
		expect(checkoutNotice('cancelled', 'waiting')?.text).toBe('Checkout was cancelled. Nothing was charged.');
	});
	it('re-reads a bounded number of times', () => {
		expect(CONFIRM_DELAYS_MS.length).toBeLessThanOrEqual(5);
		expect(CONFIRM_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15_000);
	});
});

describe('upgradeLabel', () => {
	const pro = { priceMonthlyMinor: 89_900, priceAnnualMinor: 899_000, currency: 'ZAR' };
	it('prices each interval from the offer', () => {
		expect(upgradeLabel('Pro', 'month', pro)).toBe(`Upgrade to Pro, monthly (R${NB}899.00 a month)`);
		expect(upgradeLabel('Pro', 'year', pro)).toBe(`Upgrade to Pro, yearly (R${NB}8${TS}990.00 a year)`);
	});
	it('reads unpriced without the offer or without a price for that interval', () => {
		expect(upgradeLabel('Team', 'month', null)).toBe('Upgrade to Team, monthly');
		expect(upgradeLabel('Pro', 'year', { ...pro, priceAnnualMinor: 0 })).toBe('Upgrade to Pro, yearly');
	});
});

describe('shadowNote', () => {
	it('says plans aren’t charged only when there is nothing to pay with', () => {
		expect(shadowNote(false, false, 'your account')).toBe(
			'Plans aren’t charged yet. Usage is counted against the plan’s limits so you can see where your account stands, but nothing is refused.'
		);
		const beside = shadowNote(false, true, 'this team');
		expect(beside).toBe('Limits aren’t enforced yet. Usage is counted against the plan’s limits so you can see where this team stands, but nothing is refused.');
		expect(beside).not.toContain('charged');
	});
	it('is gone once limits are enforced', () => {
		expect(shadowNote(true, false, 'your account')).toBeNull();
		expect(shadowNote(true, true, 'your account')).toBeNull();
	});
});
