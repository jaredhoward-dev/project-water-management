// The team plan page's "Change seats" control (issue #641 Phase 5, docs/ui.md
// § Plan and usage; SeatChange.svelte): pure helpers, so the component only
// lays them out. The provider prorates the change for the current period
// (docs/billing.md § Changing a Team's seats); the line here says the new
// recurring price difference, at the subscription's interval when the plan
// says which, else only the new count. English: the workspace is.
import type { AccountPlan, BillingInterval } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import { fmtPrice, MAX_CHECKOUT_SEATS, seatOffer, type SeatOffer } from './plan';

const LIVE = new Set(['trialing', 'active', 'past_due']);

/** What the control needs: the seats now and the offer's prices; null when there is no live Team subscription to change (or no online billing). */
export interface SeatChangeState {
	current: number;
	offer: SeatOffer;
	currency: string;
	/** The subscription's billing interval when app_account_plan says it (issue #641 round 5); null when unknown. */
	interval: BillingInterval | null;
}

export function seatChangeState(p: AccountPlan): SeatChangeState | null {
	const s = p.subscription;
	if (!s || !LIVE.has(s.status) || p.account.kind !== 'team' || p.plan.code !== 'team') return null;
	if (p.provider !== 'mock' && p.provider !== 'stripe') return null;
	const offer = seatOffer(p.plan);
	if (!offer) return null;
	const raw = (s as { interval?: unknown }).interval;
	const interval = raw === 'month' || raw === 'year' ? raw : null;
	return { current: s.seats, offer: { ...offer, max: Math.max(offer.included, MAX_CHECKOUT_SEATS) }, currency: p.plan.currency, interval };
}

const seatsWord = (n: number) => `${fmtNum(n)} editor seat${n === 1 ? '' : 's'}`;

/**
 * The confirm step's words for going from the current seats to `next`:
 * "From 3 to 5 editor seats: R 998.00 more a month." With no interval known,
 * "From 3 to 5 editor seats." Every change says the provider prorates it.
 */
export function seatChangeLine(st: SeatChangeState, next: number): string {
	const head = `From ${fmtNum(st.current)} to ${seatsWord(next)}`;
	const extraNow = Math.max(0, st.current - st.offer.included);
	const extraNext = Math.max(0, next - st.offer.included);
	const prorated = 'The difference for the rest of this period is prorated on the next invoice.';
	if (st.interval === null || extraNow === extraNext) return `${head}. ${prorated}`;
	const each = st.interval === 'year' ? st.offer.extraAnnualMinor : st.offer.extraMonthlyMinor;
	const diff = (extraNext - extraNow) * each;
	const per = st.interval === 'year' ? 'a year' : 'a month';
	const money = `${fmtPrice(Math.abs(diff), st.currency)} ${diff > 0 ? 'more' : 'less'} ${per}`;
	return `${head}: ${money}. ${prorated}`;
}

/** Whether `next` is a count the API takes: whole, from the included seats to the maximum, and not the current count. */
export function seatChangeValid(st: SeatChangeState, next: number | null): next is number {
	return next !== null && Number.isInteger(next) && next >= st.offer.included && next <= st.offer.max && next !== st.current;
}
