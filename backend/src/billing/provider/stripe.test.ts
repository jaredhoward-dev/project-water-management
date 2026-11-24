// Stripe events → the normalised event (stripe.ts), for each of the six types
// issue #641 names, through the committed synthetic fixtures.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normaliseStripeEvent } from './stripe.js';

const ACCOUNT = '00000000-0000-4000-8000-000000000641';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/billing/${name}.json`, import.meta.url), 'utf8'));
const iso = (s: number) => new Date(s * 1000).toISOString();
/** A fixture's subscription object, patched. */
const withSub = (name: string, patch: Record<string, unknown>) => {
	const e = fixture(name);
	Object.assign(e.data.object, patch);
	return e;
};

describe('normaliseStripeEvent', () => {
	it('customer.subscription.created and .updated are subscription.updated, with every field the SQL needs', () => {
		const created = normaliseStripeEvent(fixture('subscription-created'));
		expect(created).toEqual({
			kind: 'event',
			event: {
				eventId: 'evt_synthetic_sub_created_0001',
				type: 'subscription.updated',
				payload: {
					accountId: ACCOUNT,
					planCode: 'pro',
					status: 'trialing',
					seats: 1,
					periodStart: iso(1795000000),
					periodEnd: iso(1796209600),
					trialEnd: iso(1796209600),
					cancelAtPeriodEnd: false,
					externalRef: 'sub_synthetic_0001',
					eventCreated: iso(1795000000)
				}
			}
		});
		const updated = normaliseStripeEvent(fixture('subscription-updated'));
		expect(updated.kind === 'event' && updated.event.type).toBe('subscription.updated');
		expect(updated.kind === 'event' && updated.event.payload).toMatchObject({ status: 'active', trialEnd: iso(1796209600) });
		const pastDue = normaliseStripeEvent(fixture('subscription-past-due'));
		expect(pastDue.kind === 'event' && pastDue.event.payload).toMatchObject({ status: 'past_due', trialEnd: null });
	});

	it('timestamps are ISO 8601 with an offset (Z), as app_billing_apply requires', () => {
		const r = normaliseStripeEvent(fixture('subscription-updated'));
		if (r.kind !== 'event' || r.event.type !== 'subscription.updated') throw new Error('expected a subscription event');
		for (const t of [r.event.payload.periodStart, r.event.payload.periodEnd, r.event.payload.trialEnd]) expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it('customer.subscription.deleted is subscription.deleted, canceled', () => {
		const r = normaliseStripeEvent(fixture('subscription-deleted'));
		expect(r.kind === 'event' && r.event.type).toBe('subscription.deleted');
		expect(r.kind === 'event' && r.event.payload).toMatchObject({ accountId: ACCOUNT, externalRef: 'sub_synthetic_0001', status: 'canceled' });
	});

	it('checkout.session.completed, invoice.paid and invoice.payment_failed are recorded-only events naming the account and subscription', () => {
		for (const [name, type] of [
			['checkout-completed', 'checkout.completed'],
			['invoice-paid', 'invoice.paid'],
			['invoice-payment-failed', 'invoice.payment_failed']
		]) {
			const r = normaliseStripeEvent(fixture(name!));
			expect(r, name).toMatchObject({ kind: 'event', event: { type, payload: { accountId: ACCOUNT, externalRef: 'sub_synthetic_0001' } } });
		}
	});

	it('reads an invoice’s subscription from subscription_details on API versions before basil', () => {
		const e = fixture('invoice-paid');
		e.data.object = { id: 'in_1', object: 'invoice', subscription: 'sub_old', subscription_details: { metadata: { billing_account_id: ACCOUNT } } };
		expect(normaliseStripeEvent(e)).toMatchObject({ kind: 'event', event: { type: 'invoice.paid', payload: { accountId: ACCOUNT, externalRef: 'sub_old' } } });
	});

	it('reads the period from the subscription itself on API versions before basil', () => {
		const e = withSub('subscription-updated', { current_period_start: 1700000000, current_period_end: 1702592000 });
		e.data.object.items.data[0] = { id: 'si_1', quantity: 3 };
		expect(normaliseStripeEvent(e)).toMatchObject({ event: { payload: { periodStart: iso(1700000000), periodEnd: iso(1702592000), seats: 3 } } });
	});

	it('reads Team’s seats from both items: the included seats plus the extra-seat item, whichever order Stripe lists them in', () => {
		expect(normaliseStripeEvent(fixture('subscription-team-seats'))).toMatchObject({
			kind: 'event',
			event: { type: 'subscription.updated', payload: { planCode: 'team', seats: 5, externalRef: 'sub_synthetic_team_0001', periodEnd: iso(1798801600) } }
		});
		const e = fixture('subscription-team-seats');
		e.data.object.items.data.reverse();
		expect(normaliseStripeEvent(e)).toMatchObject({ event: { payload: { seats: 5 } } });
	});

	it('Team with no extra seats (one item) is its included seats; a portal that removed the extra item reads the same', () => {
		const e = fixture('subscription-team-seats');
		e.data.object.items.data = [e.data.object.items.data[1]];
		expect(normaliseStripeEvent(e)).toMatchObject({ event: { payload: { seats: 3 } } });
		const zero = fixture('subscription-team-seats');
		zero.data.object.items.data[0].quantity = 0;
		expect(normaliseStripeEvent(zero)).toMatchObject({ event: { payload: { seats: 3 } } });
	});

	it('refuses a seats_included that isn’t a whole number of seats, or a fractional quantity', () => {
		for (const bad of ['0', '-1', '2.5', 'three', 3]) {
			const e = fixture('subscription-team-seats');
			e.data.object.metadata.seats_included = bad;
			expect(normaliseStripeEvent(e), String(bad)).toMatchObject({ kind: 'invalid', why: 'invalid seat quantity' });
		}
		const e = fixture('subscription-team-seats');
		e.data.object.items.data[0].quantity = 1.5;
		expect(normaliseStripeEvent(e)).toMatchObject({ kind: 'invalid', why: 'invalid seat quantity' });
	});

	it('maps Stripe’s statuses: unpaid is past_due, incomplete_expired is expired, incomplete and paused are recorded only', () => {
		expect(normaliseStripeEvent(withSub('subscription-updated', { status: 'unpaid' }))).toMatchObject({ event: { type: 'subscription.updated', payload: { status: 'past_due' } } });
		expect(normaliseStripeEvent(withSub('subscription-updated', { status: 'incomplete_expired' }))).toMatchObject({ event: { type: 'subscription.updated', payload: { status: 'expired' } } });
		for (const status of ['incomplete', 'paused']) {
			const r = normaliseStripeEvent(withSub('subscription-updated', { status }));
			expect(r, status).toMatchObject({ kind: 'event', event: { type: 'subscription.pending', payload: { accountId: ACCOUNT, externalRef: 'sub_synthetic_0001' } } });
			expect(r.kind === 'event' && 'status' in r.event.payload, status).toBe(false);
		}
	});

	it('ignores a type it doesn’t act on, without reading its object', () => {
		expect(normaliseStripeEvent({ id: 'evt_x', type: 'customer.created', data: { object: {} } })).toEqual({ kind: 'ignored', eventId: 'evt_x', type: 'customer.created' });
	});

	it('refuses an event without an account, a known plan, a status it knows, a period or an id', () => {
		const bad: [string, unknown][] = [
			['not an object', []],
			['no id', { ...fixture('invoice-paid'), id: undefined }],
			['odd id', { ...fixture('invoice-paid'), id: 'evt 1;drop' }],
			['no object', { ...fixture('invoice-paid'), data: {} }],
			['no account', withSub('subscription-updated', { metadata: { plan_code: 'pro' } })],
			['account not a uuid', withSub('subscription-updated', { metadata: { billing_account_id: 'acct_1', plan_code: 'pro' } })],
			['unknown plan', withSub('subscription-updated', { metadata: { billing_account_id: ACCOUNT, plan_code: 'gold' } })],
			['unknown status', withSub('subscription-updated', { status: 'frozen' })],
			['no period', withSub('subscription-updated', { items: { data: [{ quantity: 1 }] } })],
			['no cancel flag', withSub('subscription-updated', { cancel_at_period_end: undefined })],
			['zero seats', withSub('subscription-updated', { items: { data: [{ quantity: 0, current_period_start: 1, current_period_end: 2 }] } })],
			['bad trial end', withSub('subscription-updated', { trial_end: 'soon' })],
			['bad created', { ...fixture('invoice-paid'), created: 'yesterday' }],
			['checkout without account', withSub('checkout-completed', { metadata: {} })],
			['invoice without account', withSub('invoice-paid', { parent: null })]
		];
		for (const [why, body] of bad) expect(normaliseStripeEvent(body).kind, why).toBe('invalid');
	});
});
