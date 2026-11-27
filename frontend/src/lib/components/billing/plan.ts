// The Plan and usage page's words and figures (issue #641 Phase 1, docs/ui.md
// § Plan and usage): pure helpers, so the page only lays them out. Phase 1 is
// shadow mode: usage is counted against the plan's limits, nothing is charged
// or refused, so a count past its limit is said, never blocked. The workspace
// is English; plan data never reaches a farmer page.
import { PLAN_ENDED_GRACE_DAYS } from '@water-management/engine/plans';
import type { AccountPlan, BillingInterval, LiveCatchment, LiveCatchments, Plan, Subscription } from '#lib/api/types.js';
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
			// A plan the operator gave ends on its date by design (its cancel_at_period_end is set), so it is said
			// plainly, never in the warning colour of a cancellation (330, 335).
			if (s.granted === 'staff')
				return { text: s.periodEnd ? `Granted by the operator until ${fmtDate(s.periodEnd)}` : 'Granted by the operator, with no end date', warn: false };
			if (s.granted === 'invoice') return { text: s.periodEnd ? `Paid by invoice; runs until ${fmtDate(s.periodEnd)}` : 'Paid by invoice', warn: false };
			if (!s.periodEnd) return { text: 'Active', warn: false };
			return s.cancelAtPeriodEnd
				? { text: `Ends ${fmtDate(s.periodEnd)}; it won't renew`, warn: true }
				: { text: `Renews ${fmtDate(s.periodEnd)}`, warn: false };
		case 'past_due':
			return { text: 'Payment overdue', warn: true };
		case 'lapsed':
			return { text: 'Payment overdue; paid features paused until it is paid', warn: true };
		case 'canceled':
			return { text: s.periodEnd ? `Cancelled; ended ${fmtDate(s.periodEnd)}` : 'Cancelled', warn: true };
		case 'expired':
			return { text: s.periodEnd ? `Expired ${fmtDate(s.periodEnd)}` : 'Expired', warn: true };
	}
}

/**
 * A team's subscription in editor seats: "5 editor seats (3 included, 2
 * extra)", or "3 editor seats (all included)"; null with no subscription or on
 * a personal account. What it costs is subscriptionTotalLine's.
 */
export function subscriptionSeatsLine(p: Pick<AccountPlan, 'account' | 'plan' | 'subscription'>): string | null {
	const s = p.subscription;
	if (!s || p.account.kind !== 'team') return null;
	const included = p.plan.limits?.seats_included ?? 1;
	const extra = s.seats - included;
	const seats = `${fmtNum(s.seats)} editor seat${s.seats === 1 ? '' : 's'}`;
	return extra > 0 ? `${seats} (${fmtNum(included)} included, ${fmtNum(extra)} extra)` : `${seats} (all included)`;
}

/**
 * What the subscription costs, from its interval, its seats and the plan's
 * prices: "R 3 497.00 a month for 5 editor seats" on a team (Team's price plus
 * each seat past the included ones), "R 8 990.00 a year" on a person's. Null
 * with no subscription, or no interval recorded (a staff grant, a subscription
 * from before 332), or a total of nothing: a guessed total would read as what
 * the account is charged (docs/ui.md § Plan and usage).
 */
export function subscriptionTotalLine(p: Pick<AccountPlan, 'account' | 'plan' | 'subscription'>): string | null {
	const s = p.subscription;
	if (!s || (s.interval !== 'month' && s.interval !== 'year')) return null;
	const team = p.account.kind === 'team';
	const minor = checkoutTotalMinor(p.plan, s.interval, team ? s.seats : null);
	if (!(minor > 0)) return null;
	const per = s.interval === 'month' ? 'a month' : 'a year';
	const forSeats = team ? ` for ${fmtNum(s.seats)} editor seat${s.seats === 1 ? '' : 's'}` : '';
	return `${fmtPrice(minor, p.plan.currency)} ${per}${forSeats}`;
}

/** One usage bar: its label, the figures as words, and how full it is (null when there is no bar). */
export interface UsageRow {
	key: 'catchments' | 'liveCatchments' | 'reports' | 'packsIssued' | 'assistantCost';
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
 * The page's bars, in the order the plan is read: catchments, live
 * catchments (340; left out when an older API doesn't send them), reports
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
		...(u.liveCatchments
			? [
					row('liveCatchments', 'Live catchments', u.liveCatchments.used, u.liveCatchments.limit, {
						fmt: count,
						verb: 'live',
						planName,
						note: 'A catchment is live while it has data feeds, alerts or automatic runs on, or a farm view published. Runs, calibration, scenarios and exports have no limit.'
					})
				]
			: []),
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

/** Whether the subscription is a live reverse trial (342: 14 days of Pro, no card), which checkout replaces (344). */
export function onReverseTrial(s: Subscription | null | undefined): boolean {
	return !!s && s.status === 'trialing' && s.reverseTrial === true;
}

/**
 * Whether the account has a subscription someone set up: any live one but the
 * reverse trial. Coming back from checkout, the page waits until one shows
 * (the trial was already there before the payment).
 */
export function hasPaidSubscription(p: Pick<AccountPlan, 'subscription'>): boolean {
	return !!p.subscription && !onReverseTrial(p.subscription);
}

/**
 * What the page offers for billing (Phase 3, docs/ui.md § Plan and usage):
 * nothing when the provider is `manual` or none (the operator changes plans by
 * hand); else Upgrade while there is no live subscription, or only the reverse
 * trial (which checkout replaces, 344; Pro for a person, Team for a team), and
 * Manage billing once there is any other.
 */
export function billingActions(p: AccountPlan): { upgrade: { code: 'pro' | 'team'; name: string } | null; manage: boolean } {
	if (p.provider !== 'mock' && p.provider !== 'stripe') return { upgrade: null, manage: false };
	// A staff grant has nothing at the provider to manage (no customer, no subscription there; checkout refuses it
	// too): the page says it is the operator's instead (grantNote).
	if (p.subscription?.granted === 'staff') return { upgrade: null, manage: false };
	if (hasPaidSubscription(p)) return { upgrade: null, manage: true };
	return { upgrade: p.account.kind === 'team' ? { code: 'team', name: 'Team' } : { code: 'pro', name: 'Pro' }, manage: false };
}

/** The line a staff grant shows in place of the billing buttons: who changes it. Null for anything else. */
export function grantNote(s: Subscription | null | undefined): string | null {
	return s?.granted === 'staff' && s.status === 'active' ? 'To change or end this plan, ask the operator. Nothing is charged for it here.' : null;
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

/**
 * Where Team's seat field starts: the team's editors when it has more than the
 * included seats (so checkout doesn't sell fewer seats than it uses), else the
 * included seats; never past the most one checkout sells.
 */
export function startingSeats(seats: SeatOffer, editorCount: number | null | undefined): number {
	const n = typeof editorCount === 'number' && Number.isInteger(editorCount) ? editorCount : 0;
	return Math.min(seats.max, Math.max(seats.included, n));
}

/** "This team has 4 editors", beside the seat field; null when the count isn't known (a person's account). */
export function editorsHint(editorCount: number | null | undefined): string | null {
	if (typeof editorCount !== 'number' || !Number.isInteger(editorCount) || editorCount < 0) return null;
	return `This team has ${fmtNum(editorCount)} editor${editorCount === 1 ? '' : 's'}.`;
}

/**
 * The notice when a team has more editors than its plan pays for (403, issue #926: seats cut in the provider's
 * portal): how many over, that no one loses access, that new editors are refused, and what to do. Null within its
 * seats, on a person's account, or from an older API that sends no `overSeats`.
 */
export function overSeatsNotice(plan: Pick<AccountPlan, 'team'>): string | null {
	const o = plan.team?.overSeats;
	if (!o || !Number.isInteger(o.seats) || !Number.isInteger(o.editors) || o.editors <= o.seats) return null;
	const over = o.editors - o.seats;
	const since = o.since ? ` since ${fmtDate(o.since)}` : '';
	return (
		`This team has ${fmtNum(o.editors)} editors but its plan pays for ${fmtNum(o.seats)} editor seat${o.seats === 1 ? '' : 's'}${since}: ` +
		`${fmtNum(over)} over. Everyone keeps their access, but no one new can be made an editor. ` +
		`Add ${over === 1 ? 'a seat' : `${fmtNum(over)} seats`} with Change seats, or make ${over === 1 ? 'an editor a viewer' : `${fmtNum(over)} editors viewers`}.`
	);
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

/** Stripe's hosted pages: Checkout and the customer (billing) portal. */
export const STRIPE_BILLING_HOSTS = ['checkout.stripe.com', 'billing.stripe.com'] as const;

/**
 * Where the Upgrade and Manage billing buttons may send the page: the URL the
 * API answered (`{ url }` from checkout or the portal), as an absolute href,
 * or null to refuse it. Only Stripe's Checkout or billing host on https (no
 * credentials, default port), or the mock provider's checkout or portal page
 * on the API's own origin (`apiBase`, PUBLIC_API_URL, read against the page
 * so "/api" works), http or https. Anything else (javascript:, data:, another
 * host, a lookalike such as checkout.stripe.com.evil.example) is refused.
 */
export function billingRedirect(url: unknown, apiBase: string, pageHref: string): string | null {
	if (typeof url !== 'string' || !url) return null;
	let u: URL;
	let api: URL;
	try {
		u = new URL(url);
		api = new URL(apiBase, pageHref);
	} catch {
		return null;
	}
	if (u.username || u.password) return null;
	if (u.protocol === 'https:' && u.port === '' && (STRIPE_BILLING_HOSTS as readonly string[]).includes(u.hostname)) return u.href;
	const mockPage = /\/billing\/mock\/(checkout|portal)$/.test(u.pathname);
	if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === api.origin && mockPage) return u.href;
	return null;
}

/**
 * Whether the Plan page asks for the live-catchment picker (341, 345; docs/ui.md
 * § Plan and usage): the account is on Free (no live subscription) and past
 * Free's live catchments. Whether it shows is then the list's: only once the
 * plan has ended (`overFreeSince`), never on an account that never had one.
 */
export function wantsKeepPicker(p: AccountPlan): boolean {
	const live = p.usage.liveCatchments;
	return !p.subscription && !!live && live.limit !== null && live.used > live.limit;
}

const catchments = (n: number) => `${fmtNum(n)} catchment${n === 1 ? '' : 's'}`;

/**
 * The picker's opening words, in #641's tone (an information note, never an
 * error): what Free keeps live, what pauses on the others and when, and that
 * nothing is lost. Null when the picker has nothing to say (within Free, or a
 * plan that never ended).
 */
export function keepPickerIntro(list: LiveCatchments, enforced: boolean, whose: string): string | null {
	if (!list.overFreeSince || list.freeLimit === null || list.catchments.length <= list.freeLimit) return null;
	const head = `The plan for ${whose} has ended, so it is on Free, which keeps ${catchments(list.freeLimit)} live.`;
	const lost = 'Nothing is lost: everyone can still open, run, edit and export them, and they carry on as they were on a plan again.';
	const others = 'feeds, alerts and automatic runs';
	let when: string;
	if (list.catchments.some((c) => c.pausedAt)) when = `On the others, ${others} are paused.`;
	else if (!enforced) when = `Once plan limits apply, ${others} pause on the others ${PLAN_ENDED_GRACE_DAYS} days after the plan ended.`;
	else when = list.pausesFrom ? `From ${fmtDate(list.pausesFrom)}, ${others} pause on the others.` : `Soon, ${others} pause on the others.`;
	return `${head} ${when} ${lost}`;
}

/** One catchment's state on the picker: "Stays live (your choice)", "Stays live", "Paused since 3 Dec 2026" or "Pauses from 3 Dec 2026". */
export function keepRowState(c: LiveCatchment, list: Pick<LiveCatchments, 'pausesFrom'>): string {
	if (c.staysLive) return c.chosen ? 'Stays live (your choice)' : 'Stays live';
	if (c.pausedAt) return `Paused since ${fmtDate(c.pausedAt)}`;
	return list.pausesFrom ? `Pauses from ${fmtDate(list.pausesFrom)}` : 'Pauses after the grace';
}

/** The confirm question's words for keeping `name` live in place of `current` (null: none stays live yet). */
export function keepQuestion(name: string, current: string | null): string {
	const instead = current ? ` in place of ${current}` : '';
	return `${name} keeps its feeds, alerts and automatic runs${instead}. The others are the ones that pause; nothing on them is deleted, and you can change this at any time.`;
}
