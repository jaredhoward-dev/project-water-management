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
	const seats = first?.quantity ?? 1;
	if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1 || seats > 10_000) return 'invalid seat quantity';
	// The period moved from the subscription to its items in API 2025-03-31.basil; read the item's first, then the old place.
	const periodStart = time(first?.current_period_start ?? sub.current_period_start);
	const periodEnd = time(first?.current_period_end ?? sub.current_period_end);
	const trialEnd = time(sub.trial_end);
	if (!periodStart || !periodEnd || trialEnd === undefined) return 'missing or invalid period';
	if (typeof sub.cancel_at_period_end !== 'boolean') return 'missing cancel_at_period_end';
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
		externalRef
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
