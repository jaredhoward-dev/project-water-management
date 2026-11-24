// Stripe events → the normalised event app_billing_apply takes (the round 2
// contract, docs/billing.md § Webhooks and providers). Pure: no I/O, no
// `stripe` package; the fields read are spelled as Stripe's API spells them.
//
// The six types issue #641 names, and what each becomes:
//   customer.subscription.created | .updated → subscription.updated (applied: the account's subscription upserted)
//   customer.subscription.deleted            → subscription.deleted (applied: status canceled)
//   checkout.session.completed               → checkout.completed   (recorded only: the subscription events carry the state)
//   invoice.paid                             → invoice.paid         (recorded only)
//   invoice.payment_failed                   → invoice.payment_failed (recorded only: Stripe moves the subscription to
//                                              past_due itself and sends customer.subscription.updated)
// Any other type is `ignored`: answered 200 and never written (Stripe sends
// only the types the endpoint enables, so one here is a dashboard slip).
//
// The account is the subscription's (or session's, or invoice's
// subscription_details') metadata `billing_account_id`, which checkout sets;
// the plan is its metadata `plan_code`. An event without them is `invalid`.
// The seats are its metadata `seats_included` plus the items' extra seats
// (seatsOf, below), and the interval its items' prices' recurring.interval
// (intervalOf).
import { PLAN_CODES, type NormalisedEvent, type SubscriptionPayload, type SubscriptionStatus } from '../provider.js';

export const STRIPE_EVENT_TYPES = [
	'checkout.session.completed',
	'customer.subscription.created',
	'customer.subscription.updated',
	'customer.subscription.deleted',
	'invoice.paid',
	'invoice.payment_failed'
] as const;

export type NormaliseResult = { kind: 'event'; event: NormalisedEvent } | { kind: 'ignored'; eventId: string; type: string } | { kind: 'invalid'; why: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9_]{1,255}$/;

/** A unix-seconds field as an ISO timestamp, or null when absent; undefined when present but not a time. */
function time(v: unknown): string | null | undefined {
	if (v === null || v === undefined) return null;
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 32503680000) return undefined;
	return new Date(v * 1000).toISOString();
}

/**
 * Stripe's subscription status as ours. Stripe's `unpaid` (retries exhausted,
 * the subscription kept) is past_due here: still owed, not ended.
 * `incomplete` (the first payment not yet made) and `paused` (a trial ended
 * with no payment method) grant nothing new, so they are recorded and change
 * nothing; `incomplete_expired` is expired.
 */
const STATUS: Record<string, SubscriptionStatus | 'record'> = {
	trialing: 'trialing',
	active: 'active',
	past_due: 'past_due',
	unpaid: 'past_due',
	canceled: 'canceled',
	incomplete_expired: 'expired',
	incomplete: 'record',
	paused: 'record'
};

function accountOf(metadata: unknown): string | null {
	const id = isObj(metadata) ? str(metadata.billing_account_id) : null;
	return id && UUID.test(id) ? id.toLowerCase() : null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;

/**
 * The editor seats a subscription holds: the seats its plan includes (the
 * metadata's seats_included, which checkout sets; 1 when absent) plus every
 * item's quantity past the base item's 1. Checkout makes the plan one item at
 * quantity 1 and Team's extra seats a second item of that many
 * (provider/stripeApi.ts), so the sum needs no telling which item is which,
 * and in whatever order Stripe lists them: Team with 2 extra is 3 + (1 + 2) − 1
 * = 5. A subscription made before seats were sold (one item, no
 * seats_included) reads as its one item's quantity, as before. Null when a
 * quantity or seats_included isn't a count, or the result is under 1.
 */
export function seatsOf(metadata: unknown, items: Obj[]): number | null {
	const raw = isObj(metadata) ? metadata.seats_included : undefined;
	let included = 1;
	if (raw !== undefined && raw !== null) {
		if (typeof raw !== 'string' || !/^[1-9][0-9]{0,4}$/.test(raw)) return null;
		included = Number(raw);
	}
	if (items.length === 0) return included <= 10_000 ? included : null;
	let total = 0;
	for (const item of items) {
		const q = item.quantity ?? 1;
		if (!isCount(q)) return null;
		total += q;
	}
	const seats = included + total - 1;
	return seats >= 1 && seats <= 10_000 ? seats : null;
}

/**
 * How often a subscription bills: its items' price `recurring.interval` when
 * every item says the same plain month or year (`interval_count` 1 or
 * absent). Null when the items' prices say something else (a day or week, a
 * quarter as 3 months, items that disagree, an item without a recurring
 * price beside one with): the plan page then shows no total rather than a
 * guessed one. Undefined when no item carries a price at all (an object
 * without them, like a test's), so app_billing_apply keeps what it stored
 * (332; docs/billing.md § Billing interval and editor count).
 */
export function intervalOf(items: Obj[]): 'month' | 'year' | null | undefined {
	if (!items.some((item) => item.price !== undefined)) return undefined;
	let found: 'month' | 'year' | null = null;
	for (const item of items) {
		const recurring = isObj(item.price) && isObj(item.price.recurring) ? item.price.recurring : null;
		if (!recurring) return null;
		const { interval, interval_count: count } = recurring;
		if ((interval !== 'month' && interval !== 'year') || (count !== undefined && count !== null && count !== 1)) return null;
		if (found !== null && found !== interval) return null;
		found = interval;
	}
	return found;
}

/** A subscription object as the full payload, or why it can't be. */
function subscriptionPayload(sub: Obj): SubscriptionPayload | string {
	const accountId = accountOf(sub.metadata);
	if (!accountId) return 'no billing_account_id in the subscription metadata';
	const planCode = isObj(sub.metadata) ? str(sub.metadata.plan_code) : null;
	if (!planCode || !(PLAN_CODES as readonly string[]).includes(planCode)) return 'no known plan_code in the subscription metadata';
	const externalRef = str(sub.id);
	if (!externalRef) return 'the subscription has no id';
	const status = STATUS[String(sub.status)];
	if (!status) return 'unknown subscription status';
	const items = isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data.filter(isObj) : [];
	const first = items[0];
	const seats = seatsOf(sub.metadata, items);
	if (seats === null) return 'invalid seat quantity';
	// The period moved from the subscription to its items in API 2025-03-31.basil; read the item's first, then the old place.
	const periodStart = time(first?.current_period_start ?? sub.current_period_start);
	const periodEnd = time(first?.current_period_end ?? sub.current_period_end);
	const trialEnd = time(sub.trial_end);
	if (!periodStart || !periodEnd || trialEnd === undefined) return 'missing or invalid period';
	if (typeof sub.cancel_at_period_end !== 'boolean') return 'missing cancel_at_period_end';
	const interval = intervalOf(items);
	return {
		accountId,
		planCode,
		// incomplete and paused never reach app_billing_apply as a status (normaliseStripeEvent records them); a deleted one is canceled.
		status: status === 'record' ? 'canceled' : status,
		seats,
		periodStart,
		periodEnd,
		trialEnd,
		cancelAtPeriodEnd: sub.cancel_at_period_end,
		externalRef,
		...(interval === undefined ? {} : { interval })
	};
}

/** Normalise one parsed Stripe event (the body, already signature-checked), with its `created` time as eventCreated. */
export function normaliseStripeEvent(body: unknown): NormaliseResult {
	const r = normalise(body);
	if (r.kind !== 'event' || !isObj(body)) return r;
	const created = time(body.created);
	if (created === undefined) return { kind: 'invalid', why: 'invalid created time' };
	return { kind: 'event', event: { ...r.event, payload: { ...r.event.payload, eventCreated: created } } as NormalisedEvent };
}

function normalise(body: unknown): NormaliseResult {
	if (!isObj(body)) return { kind: 'invalid', why: 'the body is not a JSON object' };
	const eventId = str(body.id);
	const type = str(body.type);
	if (!eventId || !EVENT_ID.test(eventId)) return { kind: 'invalid', why: 'no event id' };
	if (!type) return { kind: 'invalid', why: 'no event type' };
	if (!(STRIPE_EVENT_TYPES as readonly string[]).includes(type)) return { kind: 'ignored', eventId, type };
	const object = isObj(body.data) && isObj(body.data.object) ? body.data.object : null;
	if (!object) return { kind: 'invalid', why: 'no data.object' };

	if (type.startsWith('customer.subscription.')) {
		const payload = subscriptionPayload(object);
		if (typeof payload === 'string') return { kind: 'invalid', why: payload };
		if (type === 'customer.subscription.deleted') return { kind: 'event', event: { eventId, type: 'subscription.deleted', payload: { ...payload, status: 'canceled' } } };
		// incomplete and paused: recorded, never applied (STATUS above).
		if (STATUS[String(object.status)] === 'record') return { kind: 'event', event: { eventId, type: 'subscription.pending', payload: { accountId: payload.accountId, externalRef: payload.externalRef } } };
		return { kind: 'event', event: { eventId, type: 'subscription.updated', payload } };
	}

	if (type === 'checkout.session.completed') {
		const accountId = accountOf(object.metadata);
		if (!accountId) return { kind: 'invalid', why: 'no billing_account_id in the session metadata' };
		const sub = object.subscription;
		return { kind: 'event', event: { eventId, type: 'checkout.completed', payload: { accountId, externalRef: str(sub) ?? (isObj(sub) ? str(sub.id) : null) } } };
	}

	// invoice.paid, invoice.payment_failed: the account from the invoice's subscription metadata
	// (parent.subscription_details since API 2025-03-31.basil, subscription_details before).
	const parent = isObj(object.parent) && isObj(object.parent.subscription_details) ? object.parent.subscription_details : null;
	const details = parent ?? (isObj(object.subscription_details) ? object.subscription_details : null);
	const accountId = accountOf(details?.metadata);
	if (!accountId) return { kind: 'invalid', why: 'no billing_account_id in the invoice’s subscription metadata' };
	const sub = details?.subscription ?? object.subscription;
	return {
		kind: 'event',
		event: { eventId, type: type === 'invoice.paid' ? 'invoice.paid' : 'invoice.payment_failed', payload: { accountId, externalRef: str(sub) ?? (isObj(sub) ? str(sub.id) : null) } }
	};
}
