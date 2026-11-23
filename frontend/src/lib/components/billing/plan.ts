// The Plan and usage page's words and figures (issue #641 Phase 1, docs/ui.md
// § Plan and usage): pure helpers, so the page only lays them out. Phase 1 is
// shadow mode: usage is counted against the plan's limits, nothing is charged
// or refused, so a count past its limit is said, never blocked. The workspace
// is English; plan data never reaches a farmer page.
import type { AccountPlan, BillingInterval, Plan, Subscription } from '#lib/api/types.js';
import { fmtDate, fmtNum } from '#lib/format/number.js';

/**
 * A price in minor units (cents) as people read it: "R 899.00" for ZAR, else
 * "USD 15.00", the symbol held to the figure by a no-break space; nothing at
 * all is "No charge".
 */
export function fmtPrice(minor: number, currency: string): string {
	if (minor === 0) return 'No charge';
	const amount = fmtNum(minor / 100, 2);
	return `${currency === 'ZAR' ? 'R' : currency}\u00a0${amount}`;
}

/** The plan's prices on one line: "R 899.00 a month or R 8 990.00 a year". */
export function priceLine(plan: AccountPlan['plan']): string {
	if (plan.priceMonthlyMinor === 0 && plan.priceAnnualMinor === 0) return 'No charge';
	const parts = [`${fmtPrice(plan.priceMonthlyMinor, plan.currency)} a month`];
	if (plan.priceAnnualMinor > 0) parts.push(`${fmtPrice(plan.priceAnnualMinor, plan.currency)} a year`);
	return parts.join(' or ');
}

/** "YYYY-MM" as "November 2026"; anything else unchanged. */
export function monthName(month: string): string {
	const m = /^(\d{4})-(\d{2})$/.exec(month);
	if (!m) return month;
	const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
	const i = Number(m[2]) - 1;
	return names[i] ? `${names[i]} ${m[1]}` : month;
}

/** What the subscription's dates say, and whether it needs attention; null with no subscription (Free). */
export function subscriptionLine(s: Subscription | null): { text: string; warn: boolean } | null {
	if (!s) return null;
	switch (s.status) {
		case 'trialing':
			return { text: s.trialEnd ? `Trial ends ${fmtDate(s.trialEnd)}` : 'On a trial', warn: false };
		case 'active':
			if (!s.periodEnd) return { text: 'Active', warn: false };
			return s.cancelAtPeriodEnd
				? { text: `Ends ${fmtDate(s.periodEnd)}; it won't renew`, warn: true }
				: { text: `Renews ${fmtDate(s.periodEnd)}`, warn: false };
		case 'past_due':
			return { text: 'Payment overdue', warn: true };
		case 'canceled':
			return { text: s.periodEnd ? `Cancelled; ended ${fmtDate(s.periodEnd)}` : 'Cancelled', warn: true };
		case 'expired':
			return { text: s.periodEnd ? `Expired ${fmtDate(s.periodEnd)}` : 'Expired', warn: true };
	}
}

/**
 * A team's subscription in editor seats: "5 editor seats (3 included, 2
 * extra)", or "3 editor seats (all included)"; null with no subscription or on
 * a personal account. No total is shown: the subscription doesn't record
 * whether it is billed monthly or yearly (docs/ui.md § Plan and usage).
 */
export function subscriptionSeatsLine(p: Pick<AccountPlan, 'account' | 'plan' | 'subscription'>): string | null {
	const s = p.subscription;
	if (!s || p.account.kind !== 'team') return null;
	const included = p.plan.limits?.seats_included ?? 1;
	const extra = s.seats - included;
	const seats = `${fmtNum(s.seats)} editor seat${s.seats === 1 ? '' : 's'}`;
	return extra > 0 ? `${seats} (${fmtNum(included)} included, ${fmtNum(extra)} extra)` : `${seats} (all included)`;
}

/** One usage bar: its label, the figures as words, and how full it is (null when there is no bar). */
export interface UsageRow {
	key: 'catchments' | 'reports' | 'packsIssued' | 'assistantCost';
	label: string;
	used: number;
	limit: number | null;
	/** "3 of 5", "12 used" when unlimited, or "Not included in Free" at a zero limit. */
	figures: string;
	/** "Unlimited", "2 left", "At the limit" or "1 over the limit"; null at a zero limit, where the figures say it all. */
	status: string | null;
	/** 0–1 for the bar; null when unlimited or not included (no bar). */
	fraction: number | null;
	/** Past the limit, or any use of something the plan doesn't include. */
	over: boolean;
	/** A line under the row, when it needs one. */
	note: string | null;
}

/** US dollars from millionths ("$1.00"), for the assistant's cost. */
export function fmtUsdMicros(micros: number): string {
	return `$${fmtNum(micros / 1_000_000, 2)}`;
}

interface RowWords {
	/** The figure as words: a count, or dollars. */
	fmt: (n: number) => string;
	/** The verb a zero-limit row uses for its use: "2 issued; not included in Free". */
	verb: string;
	/** The plan's name, for a zero limit. */
	planName: string;
	note?: string | null;
}

function row(key: UsageRow['key'], label: string, used: number, limit: number | null, w: RowWords): UsageRow {
	const note = w.note ?? null;
	if (limit === null) return { key, label, used, limit, figures: `${w.fmt(used)} used`, status: 'Unlimited', fraction: null, over: false, note };
	// A zero limit is a thing the plan doesn't include, not a full allowance: no bar, no "At the limit".
	if (limit <= 0) {
		const figures = used > 0 ? `${w.fmt(used)} ${w.verb}; not included in ${w.planName}` : `Not included in ${w.planName}`;
		return { key, label, used, limit, figures, status: null, fraction: null, over: used > 0, note };
	}
	const left = limit - used;
	const status = left > 0 ? `${w.fmt(left)} left` : left === 0 ? 'At the limit' : `${w.fmt(-left)} over the limit`;
	return { key, label, used, limit, figures: `${w.fmt(used)} of ${w.fmt(limit)}`, status, fraction: Math.min(1, used / limit), over: left < 0, note };
}

const count = (n: number) => fmtNum(n);

/**
 * The page's four bars, in the order the plan is read: catchments, reports
 * this month, packs issued this month, the assistant's spend this month. The
 * assistant is capped by cost, so its row is in dollars, counted by the UTC
 * month (the others by South African time), and says when some turns carry
 * no price, since its figure is then short.
 */
export function usageRows(p: AccountPlan): UsageRow[] {
	const u = p.usage;
	const month = monthName(u.month);
	const planName = p.plan.name;
	const cost = u.assistantCost;
	const notes = ['Counted by the UTC month, which starts at 02:00 South African time on the 1st.'];
	if (cost.unpricedTurns > 0) notes.unshift(`Some turns unpriced (${fmtNum(cost.unpricedTurns)}), so the true cost is higher.`);
	return [
		row('catchments', 'Catchments', u.catchments.used, u.catchments.limit, {
			fmt: count,
			verb: 'counted',
			planName,
			note: 'Every catchment billed to this account counts, whoever made it.'
		}),
		row('reports', `Reports in ${month}`, u.reports.used, u.reports.limit, { fmt: count, verb: 'made', planName }),
		row('packsIssued', `Evidence packs issued in ${month}`, u.packsIssued.used, u.packsIssued.limit, { fmt: count, verb: 'issued', planName }),
		row('assistantCost', `Assistant use in ${month}`, cost.usedUsdMicros, cost.limitUsdMicros, {
			fmt: fmtUsdMicros,
			verb: 'used',
			planName,
			note: notes.join(' ')
		})
	];
}

/**
 * What the page offers for billing (Phase 3, docs/ui.md § Plan and usage):
 * nothing when the provider is `manual` or none (the operator changes plans by
 * hand); else Upgrade while there is no live subscription (Pro for a person,
 * Team for a team), and Manage billing once there is one.
 */
export function billingActions(p: AccountPlan): { upgrade: { code: 'pro' | 'team'; name: string } | null; manage: boolean } {
	if (p.provider !== 'mock' && p.provider !== 'stripe') return { upgrade: null, manage: false };
	if (p.subscription) return { upgrade: null, manage: true };
	return { upgrade: p.account.kind === 'team' ? { code: 'team', name: 'Team' } : { code: 'pro', name: 'Pro' }, manage: false };
}

/** The most editor seats one checkout sells; the API holds the same ceiling (billing/provider.ts MAX_CHECKOUT_SEATS) and refuses past it. */
export const MAX_CHECKOUT_SEATS = 50;

type Offer = Pick<Plan, 'priceMonthlyMinor' | 'priceAnnualMinor' | 'currency'> & Partial<Pick<Plan, 'limits' | 'features'>>;

/** What a plan sells in editor seats: the included ones and each extra one's price; null when it sells no extra seats (Pro). */
export interface SeatOffer {
	included: number;
	max: number;
	extraMonthlyMinor: number;
	extraAnnualMinor: number;
}

const minorOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The offer's seats (Team: 3 included, R 499.00 a month for each extra), or null when it sells no extra seats at both intervals. */
export function seatOffer(offer: Offer | null): SeatOffer | null {
	if (!offer) return null;
	const month = minorOf(offer.features?.extra_seat_monthly_minor);
	const year = minorOf(offer.features?.extra_seat_annual_minor);
	if (month === null || year === null) return null;
	const n = offer.limits?.seats_included;
	const included = typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1;
	return { included, max: Math.max(included, MAX_CHECKOUT_SEATS), extraMonthlyMinor: month, extraAnnualMinor: year };
}

/** What `seats` editor seats cost at `interval`: the plan's price plus each seat past the included ones. */
export function checkoutTotalMinor(offer: Offer, interval: BillingInterval, seats: number | null = null): number {
	const base = interval === 'month' ? offer.priceMonthlyMinor : offer.priceAnnualMinor;
	const so = seatOffer(offer);
	if (!so || seats === null) return base;
	const extra = Math.max(0, seats - so.included);
	return base + extra * (interval === 'month' ? so.extraMonthlyMinor : so.extraAnnualMinor);
}

/** The line under the seat field: "3 editor seats included; each extra one is R 499.00 a month or R 4 990.00 a year." */
export function seatHint(seats: SeatOffer, currency: string): string {
	return `${fmtNum(seats.included)} editor seats included; each extra one is ${fmtPrice(seats.extraMonthlyMinor, currency)} a month or ${fmtPrice(seats.extraAnnualMinor, currency)} a year. Up to ${fmtNum(seats.max)}.`;
}

/**
 * One Upgrade button's words, with the price when the plans are known
 * (`GET /billing/plans`): "Upgrade to Pro, monthly (R 899.00 a month)". With a
 * seat count (Team), the price is for those seats and says so: "Upgrade to
 * Team, monthly (R 3 497.00 a month for 5 editor seats)". Without the offer
 * (still loading, or the call failed) the button reads without it, and so it
 * does on an offer that sells seats while no valid count is chosen (`seats`
 * null): a price for some other count would read as a different offer.
 */
export function upgradeLabel(name: string, interval: BillingInterval, offer: Offer | null, seats: number | null = null): string {
	const base = `Upgrade to ${name}, ${interval === 'month' ? 'monthly' : 'yearly'}`;
	if (!offer) return base;
	const sellsSeats = !!seatOffer(offer);
	if (sellsSeats && seats === null) return base;
	const minor = checkoutTotalMinor(offer, interval, seats);
	if (!(minor > 0)) return base;
	const per = interval === 'month' ? 'a month' : 'a year';
	const forSeats = seats !== null && sellsSeats ? ` for ${fmtNum(seats)} editor seat${seats === 1 ? '' : 's'}` : '';
	return `${base} (${fmtPrice(minor, offer.currency)} ${per}${forSeats})`;
}

/**
 * The shadow-mode note while limits aren't enforced, or null once they are.
 * With no billing buttons it says plans aren't charged; beside Upgrade or
 * Manage billing (which can charge) it says only that limits aren't enforced.
 */
export function shadowNote(enforced: boolean, hasActions: boolean, whose: string): string | null {
	if (enforced) return null;
	const rest = `Usage is counted against the plan’s limits so you can see where ${whose} stands, but nothing is refused.`;
	return hasActions ? `Limits aren’t enforced yet. ${rest}` : `Plans aren’t charged yet. ${rest}`;
}

/** Where confirming a paid checkout stands: the plan page re-reads the plan a few times until the subscription shows. */
export type ConfirmState = 'waiting' | 'confirmed' | 'unconfirmed';

/**
 * The line shown on coming back from checkout (`?checkout=done` or
 * `cancelled`), or null. A paid checkout is confirmed by the provider's
 * webhook, which can land after the person is back: until the subscription
 * shows, the line says it is waiting, and if it still hasn't after the
 * page's few re-reads, to reload in a minute.
 */
export function checkoutNotice(q: string | null, confirm: ConfirmState = 'confirmed'): { text: string; done: boolean } | null {
	if (q === 'done') {
		if (confirm === 'waiting') return { text: 'Thank you: the payment went through. Waiting for the payment provider to confirm…', done: true };
		if (confirm === 'unconfirmed')
			return { text: 'Thank you: the payment went through, but the payment provider hasn’t confirmed it yet. Reload the page in a minute.', done: true };
		return { text: 'Thank you: the payment went through.', done: true };
	}
	if (q === 'cancelled') return { text: 'Checkout was cancelled. Nothing was charged.', done: false };
	return null;
}

/** How long the plan page waits before each re-read while a paid checkout is unconfirmed (ms; bounded: about 15 s in all). */
export const CONFIRM_DELAYS_MS = [1000, 2000, 3000, 4000, 5000];
