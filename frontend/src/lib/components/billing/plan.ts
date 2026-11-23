// The Plan and usage page's words and figures (issue #641 Phase 1, docs/ui.md
// § Plan and usage): pure helpers, so the page only lays them out. Phase 1 is
// shadow mode: usage is counted against the plan's limits, nothing is charged
// or refused, so a count past its limit is said, never blocked. The workspace
// is English; plan data never reaches a farmer page.
import type { AccountPlan, Subscription, UsageCount } from '#lib/api/types.js';
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

/** One usage bar: its label, the figures as words, and how full it is (null when unlimited). */
export interface UsageRow {
	key: 'catchments' | 'reports' | 'packsIssued' | 'assistantTokens';
	label: string;
	used: number;
	limit: number | null;
	/** "3 of 5", or "12 used" when unlimited. */
	figures: string;
	/** "Unlimited", "2 left", "At the limit" or "1 over the limit". */
	status: string;
	/** 0–1 for the bar; null when unlimited (no bar). */
	fraction: number | null;
	over: boolean;
	/** A line under the row, when it needs one. */
	note: string | null;
}

/** US dollars from millionths ("$1.00"), for the assistant's cost cap. */
export function fmtUsdMicros(micros: number): string {
	return `$${fmtNum(micros / 1_000_000, 2)}`;
}

function row(key: UsageRow['key'], label: string, c: UsageCount, note: string | null = null): UsageRow {
	const { used, limit } = c;
	if (limit === null) return { key, label, used, limit, figures: `${fmtNum(used)} used`, status: 'Unlimited', fraction: null, over: false, note };
	const left = limit - used;
	const status = left > 0 ? `${fmtNum(left)} left` : left === 0 ? 'At the limit' : `${fmtNum(-left)} over the limit`;
	const fraction = limit <= 0 ? (used > 0 ? 1 : 0) : Math.min(1, used / limit);
	return { key, label, used, limit, figures: `${fmtNum(used)} of ${fmtNum(limit)}`, status, fraction, over: left < 0, note };
}

/**
 * The page's four bars, in the order the plan is read: catchments, reports
 * this month, packs issued this month, assistant tokens this month. The
 * assistant is capped by cost, not tokens, so its row says the plan's
 * monthly allowance in dollars beside the count.
 */
export function usageRows(p: AccountPlan): UsageRow[] {
	const u = p.usage;
	const month = monthName(u.month);
	const usd = p.plan.limits.assistant_usd_micros_per_month ?? null;
	const perSeat = p.plan.limits.assistant_usd_micros_per_seat_month ?? null;
	const assistantNote =
		usd !== null
			? `Capped by cost, not tokens: ${fmtUsdMicros(usd)} of assistant use a month.`
			: perSeat !== null
				? `Capped by cost, not tokens: ${fmtUsdMicros(perSeat)} of assistant use per seat a month.`
				: null;
	return [
		row('catchments', 'Catchments', u.catchments, 'Active catchments: archived ones don’t count.'),
		row('reports', `Reports in ${month}`, u.reports),
		row('packsIssued', `Evidence packs issued in ${month}`, u.packsIssued),
		row('assistantTokens', `Assistant tokens in ${month}`, u.assistantTokens, assistantNote)
	];
}
