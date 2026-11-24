import { describe, expect, it } from 'vitest';
import type { AccountPlan, Subscription } from '#lib/api/types.js';
import {
	CONFIRM_DELAYS_MS,
	MAX_CHECKOUT_SEATS,
	billingActions,
	billingRedirect,
	hasPaidSubscription,
	onReverseTrial,
	checkoutNotice,
	checkoutTotalMinor,
	editorsHint,
	fmtPrice,
	fmtUsdMicros,
	monthName,
	priceLine,
	seatHint,
	seatOffer,
	shadowNote,
	startingSeats,
	subscriptionLine,
	subscriptionSeatsLine,
	subscriptionTotalLine,
	keepPickerIntro,
	keepQuestion,
	keepRowState,
	upgradeLabel,
	usageRows,
	wantsKeepPicker
} from './plan';
import type { LiveCatchments } from '#lib/api/types.js';

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
		team: null,
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
	interval: null,
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

describe('subscriptionSeatsLine', () => {
	const team = (seats: number | null) =>
		plan({
			account: { id: 't1', kind: 'team' },
			plan: { ...plan().plan, code: 'team', name: 'Team', limits: { seats_included: 3 } },
			subscription: seats === null ? null : sub({ seats })
		});
	it('says a team’s seats, the included and the extra ones', () => {
		expect(subscriptionSeatsLine(team(5))).toBe('5 editor seats (3 included, 2 extra)');
		expect(subscriptionSeatsLine(team(3))).toBe('3 editor seats (all included)');
	});
	it('is nothing with no subscription, or on a personal account', () => {
		expect(subscriptionSeatsLine(team(null))).toBeNull();
		expect(subscriptionSeatsLine(plan({ subscription: sub({ seats: 1 }) }))).toBeNull();
	});
});

describe('subscriptionTotalLine', () => {
	const teamPlan = {
		...plan().plan,
		code: 'team' as const,
		name: 'Team',
		priceMonthlyMinor: 249_900,
		priceAnnualMinor: 2_499_000,
		limits: { seats_included: 3 },
		features: { extra_seat_monthly_minor: 49_900, extra_seat_annual_minor: 499_000 }
	};
	const team = (s: Partial<Subscription> | null) => plan({ account: { id: 't1', kind: 'team' }, plan: teamPlan, subscription: s === null ? null : sub(s), team: { editorCount: 5, assistantMemberMaxPct: 50 } });
	const pro = (s: Partial<Subscription>) =>
		plan({ plan: { ...plan().plan, code: 'pro', name: 'Pro', priceMonthlyMinor: 89_900, priceAnnualMinor: 899_000, limits: { seats_included: 1 } }, subscription: sub(s) });

	it('works out a Team’s total from its interval, seats and the plan’s prices', () => {
		expect(subscriptionTotalLine(team({ seats: 5, interval: 'month' }))).toBe(`R${NB}3${TS}497.00 a month for 5 editor seats`);
		expect(subscriptionTotalLine(team({ seats: 5, interval: 'year' }))).toBe(`R${NB}34${TS}970.00 a year for 5 editor seats`);
		expect(subscriptionTotalLine(team({ seats: 3, interval: 'month' }))).toBe(`R${NB}2${TS}499.00 a month for 3 editor seats`);
	});
	it('a person’s subscription is the plan’s price at its interval, with no seats', () => {
		expect(subscriptionTotalLine(pro({ interval: 'month' }))).toBe(`R${NB}899.00 a month`);
		expect(subscriptionTotalLine(pro({ interval: 'year' }))).toBe(`R${NB}8${TS}990.00 a year`);
	});
	it('guesses nothing: no interval (a grant, a subscription from before it was kept), no subscription, or nothing to pay', () => {
		expect(subscriptionTotalLine(team({ seats: 5, interval: null }))).toBeNull();
		expect(subscriptionTotalLine(pro({ interval: null }))).toBeNull();
		expect(subscriptionTotalLine(team(null))).toBeNull();
		expect(subscriptionTotalLine(plan({ subscription: sub({ interval: 'month' }) }))).toBeNull();
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
	it('shows live catchments after catchments (340): "1 of 1", at the limit, never an error; unlimited on Pro and Team', () => {
		const live = withUsage({ liveCatchments: { used: 1, limit: 1 } });
		expect(live.map((r) => r.key)).toEqual(['catchments', 'liveCatchments', 'reports', 'packsIssued', 'assistantCost']);
		expect(live[1]!).toMatchObject({ label: 'Live catchments', figures: '1 of 1', status: 'At the limit', fraction: 1, over: false });
		expect(live[1]!.note).toMatch(/data feeds, alerts or automatic runs on, or a farm view published/);
		expect(live[1]!.note).not.toMatch(/quota|abuse|402/i);
		// Past it (live before enforcement, or after a downgrade): counted, the warning colour, not refused.
		expect(withUsage({ liveCatchments: { used: 2, limit: 1 } })[1]!).toMatchObject({ status: '1 over the limit', over: true });
		expect(withUsage({ liveCatchments: { used: 4, limit: null } })[1]!).toMatchObject({ figures: '4 used', status: 'Unlimited', fraction: null });
	});
	it('leaves live catchments out when an API older than 340 doesn’t send them', () => {
		expect(rows.some((r) => r.key === 'liveCatchments')).toBe(false);
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
	it('offers Upgrade during a live reverse trial (checkout replaces it, 344), Manage billing on any other trial', () => {
		const trial = sub({ status: 'trialing', trialEnd: '2026-12-07T10:00:00.000Z', reverseTrial: true });
		expect(billingActions(plan({ subscription: trial }))).toEqual({ upgrade: { code: 'pro', name: 'Pro' }, manage: false });
		expect(billingActions(plan({ provider: 'manual', subscription: trial }))).toEqual({ upgrade: null, manage: false });
		// A Stripe trial (set by hand in Stripe's dashboard) and an older API without the flag: Manage billing.
		expect(billingActions(plan({ subscription: sub({ status: 'trialing', reverseTrial: false }) }))).toEqual({ upgrade: null, manage: true });
		expect(billingActions(plan({ subscription: sub({ status: 'trialing' }) }))).toEqual({ upgrade: null, manage: true });
	});
});

describe('onReverseTrial and hasPaidSubscription', () => {
	it('tells the reverse trial from a subscription someone set up', () => {
		expect(onReverseTrial(null)).toBe(false);
		expect(onReverseTrial(sub({ status: 'trialing', reverseTrial: true }))).toBe(true);
		// Expired: no longer live, whatever the flag says.
		expect(onReverseTrial(sub({ status: 'expired', reverseTrial: true }))).toBe(false);
		expect(hasPaidSubscription(plan())).toBe(false);
		expect(hasPaidSubscription(plan({ subscription: sub({ status: 'trialing', reverseTrial: true }) }))).toBe(false);
		expect(hasPaidSubscription(plan({ subscription: sub({}) }))).toBe(true);
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

describe('Team seats at checkout', () => {
	const team = {
		priceMonthlyMinor: 249_900,
		priceAnnualMinor: 2_499_000,
		currency: 'ZAR',
		limits: { seats_included: 3 },
		features: { extra_seat_monthly_minor: 49_900, extra_seat_annual_minor: 499_000 }
	};
	const pro = { priceMonthlyMinor: 89_900, priceAnnualMinor: 899_000, currency: 'ZAR', limits: { seats_included: 1 }, features: {} };

	it('seatOffer: Team sells seats past its 3 included; Pro, or an offer not loaded, sells none', () => {
		expect(seatOffer(team)).toEqual({ included: 3, max: MAX_CHECKOUT_SEATS, extraMonthlyMinor: 49_900, extraAnnualMinor: 499_000 });
		expect(seatOffer(pro)).toBeNull();
		expect(seatOffer(null)).toBeNull();
		expect(seatOffer({ ...team, features: { extra_seat_monthly_minor: 49_900 } })).toBeNull();
	});

	it('checkoutTotalMinor: the base plus each extra seat at the interval’s price', () => {
		expect(checkoutTotalMinor(team, 'month', 3)).toBe(249_900);
		expect(checkoutTotalMinor(team, 'month', 5)).toBe(249_900 + 2 * 49_900);
		expect(checkoutTotalMinor(team, 'year', 4)).toBe(2_499_000 + 499_000);
		expect(checkoutTotalMinor(team, 'month', null)).toBe(249_900);
		expect(checkoutTotalMinor(pro, 'month', 5)).toBe(89_900);
	});

	it('upgradeLabel prices the seats chosen, and says how many', () => {
		expect(upgradeLabel('Team', 'month', team, 5)).toBe(`Upgrade to Team, monthly (R${NB}3${TS}497.00 a month for 5 editor seats)`);
		expect(upgradeLabel('Team', 'year', team, 3)).toBe(`Upgrade to Team, yearly (R${NB}24${TS}990.00 a year for 3 editor seats)`);
		expect(upgradeLabel('Pro', 'month', pro, null)).toBe(`Upgrade to Pro, monthly (R${NB}899.00 a month)`);
		// No valid count chosen (the field is blank or wrong): no price, rather than one for some other count.
		expect(upgradeLabel('Team', 'month', team, null)).toBe('Upgrade to Team, monthly');
		expect(upgradeLabel('Team', 'year', team)).toBe('Upgrade to Team, yearly');
	});

	it('startingSeats: the team’s editors when they pass the included seats, else the included ones, never past the maximum', () => {
		const offer = seatOffer(team)!;
		expect(startingSeats(offer, 5)).toBe(5);
		expect(startingSeats(offer, 2)).toBe(3);
		expect(startingSeats(offer, 0)).toBe(3);
		expect(startingSeats(offer, null)).toBe(3);
		expect(startingSeats(offer, undefined)).toBe(3);
		expect(startingSeats(offer, MAX_CHECKOUT_SEATS + 10)).toBe(MAX_CHECKOUT_SEATS);
	});

	it('editorsHint says how many editors the team has; nothing when unknown', () => {
		expect(editorsHint(4)).toBe('This team has 4 editors.');
		expect(editorsHint(1)).toBe('This team has 1 editor.');
		expect(editorsHint(null)).toBeNull();
		expect(editorsHint(undefined)).toBeNull();
	});

	it('seatHint names the included seats, each extra one’s prices and the maximum', () => {
		expect(seatHint(seatOffer(team)!, 'ZAR')).toBe(
			`3 editor seats included; each extra one is R${NB}499.00 a month or R${NB}4${TS}990.00 a year. Up to ${MAX_CHECKOUT_SEATS}.`
		);
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

describe('billingRedirect', () => {
	const page = 'https://app.example/account/plan';
	it('opens Stripe’s Checkout and billing portal on https', () => {
		expect(billingRedirect('https://checkout.stripe.com/c/pay/cs_test_a1#fid', '/api', page)).toBe('https://checkout.stripe.com/c/pay/cs_test_a1#fid');
		expect(billingRedirect('https://billing.stripe.com/p/session/test_1', '/api', page)).toBe('https://billing.stripe.com/p/session/test_1');
	});
	it('opens the mock’s checkout and portal on the API’s own origin, absolute or relative', () => {
		expect(billingRedirect('http://localhost:3001/billing/mock/checkout?t=a.b', 'http://localhost:3001', 'http://localhost:7777/account/plan')).toBe(
			'http://localhost:3001/billing/mock/checkout?t=a.b'
		);
		expect(billingRedirect('https://app.example/billing/mock/portal?t=x', '/api', page)).toBe('https://app.example/billing/mock/portal?t=x');
	});
	it('refuses anything else', () => {
		const api = 'http://localhost:3001';
		for (const bad of [
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'http://checkout.stripe.com/c/pay/cs_1',
			'https://checkout.stripe.com:8443/c/pay/cs_1',
			'https://checkout.stripe.com.evil.example/c/pay',
			'https://evil.example/billing/mock/checkout?t=x',
			'https://user:pw@checkout.stripe.com/c/pay',
			'https://stripe.com/',
			'http://localhost:3001/auth/me',
			'http://localhost:3002/billing/mock/checkout',
			'/billing/mock/checkout',
			'//evil.example/billing/mock/checkout',
			'',
			null,
			42
		]) {
			expect(billingRedirect(bad, api, 'http://localhost:7777/account/plan'), String(bad)).toBeNull();
		}
	});
});

describe('the live-catchment picker (341, 345)', () => {
	const live = (used: number, limit: number | null) => plan({ usage: { ...plan().usage, liveCatchments: { used, limit } } });
	const list = (over: Partial<LiveCatchments> = {}): LiveCatchments => ({
		freeLimit: 1,
		overFreeSince: '2026-11-20T08:00:00Z',
		pausesFrom: '2026-12-04T08:00:00Z',
		catchments: [
			{ id: 'c', name: 'Catchment C', chosen: false, staysLive: true, pausedAt: null },
			{ id: 'a', name: 'Catchment A', chosen: false, staysLive: false, pausedAt: null }
		],
		...over
	});

	it('is asked for only on Free past its live catchments', () => {
		expect(wantsKeepPicker(live(2, 1))).toBe(true);
		expect(wantsKeepPicker(live(1, 1))).toBe(false);
		expect(wantsKeepPicker(live(3, null))).toBe(false);
		expect(wantsKeepPicker(plan())).toBe(false);
		expect(wantsKeepPicker({ ...live(2, 1), subscription: sub({}) })).toBe(false);
	});

	it('says nothing on an account whose plan never ended, or within Free', () => {
		expect(keepPickerIntro(list({ overFreeSince: null, pausesFrom: null }), true, 'your account')).toBeNull();
		expect(keepPickerIntro(list({ catchments: list().catchments.slice(0, 1) }), true, 'your account')).toBeNull();
	});

	it('in the grace, says when the others pause and that nothing is lost', () => {
		const t = keepPickerIntro(list(), true, 'your account')!;
		expect(t).toMatch(/^The plan for your account has ended, so it is on Free, which keeps 1 catchment live\. From /);
		expect(t).toContain('feeds, alerts and automatic runs pause on the others');
		expect(t).toContain('Nothing is lost');
	});

	it('once paused, says so; with limits not applied yet, says when they would', () => {
		const paused = list({ catchments: [list().catchments[0]!, { ...list().catchments[1]!, pausedAt: '2026-12-04T08:05:00Z' }] });
		expect(keepPickerIntro(paused, true, 'this team')).toContain('On the others, feeds, alerts and automatic runs are paused.');
		expect(keepPickerIntro(list(), false, 'this team')).toContain('Once plan limits apply');
	});

	it('names each row’s state', () => {
		const [c, a] = list().catchments as [LiveCatchments['catchments'][0], LiveCatchments['catchments'][0]];
		expect(keepRowState(c, list())).toBe('Stays live');
		expect(keepRowState({ ...c, chosen: true }, list())).toBe('Stays live (your choice)');
		expect(keepRowState(a, list())).toMatch(/^Pauses from /);
		expect(keepRowState({ ...a, pausedAt: '2026-12-04T08:05:00Z' }, list())).toMatch(/^Paused since /);
		expect(keepRowState(a, { pausesFrom: null })).toBe('Pauses after the grace');
	});

	it('asks in plain words, never the ones #641 rules out', () => {
		expect(keepQuestion('Catchment A', 'Catchment C')).toMatch(/^Catchment A keeps its feeds, alerts and automatic runs in place of Catchment C\./);
		expect(keepQuestion('Catchment A', null)).not.toContain('in place of');
		for (const t of [keepQuestion('A', 'C'), keepPickerIntro(list(), true, 'your account')!]) expect(t).not.toMatch(/quota|abuse|402/i);
	});
});
