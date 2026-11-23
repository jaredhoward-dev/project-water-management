// The Plan and usage page's words and figures (issue #641 Phase 1, docs/ui.md
// § Plan and usage): pure helpers, so the page only lays them out. Phase 1 is
// shadow mode: usage is counted against the plan's limits, nothing is charged
// or refused, so a count past its limit is said, never blocked. The workspace
// is English; plan data never reaches a farmer page.
import type { AccountPlan, Subscription } from '#lib/api/types.js';
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

/** The line shown on coming back from checkout (`?checkout=done` or `cancelled`), or null. */
export function checkoutNotice(q: string | null): { text: string; done: boolean } | null {
	if (q === 'done') return { text: 'Thank you: the payment went through. If the plan below hasn’t changed yet, reload the page in a minute.', done: true };
	if (q === 'cancelled') return { text: 'Checkout was cancelled. Nothing was charged.', done: false };
	return null;
}
