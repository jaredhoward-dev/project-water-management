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
				environment: 'local',
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

	it('carries the deployment tag checkout stamped (metadata wm_environment) beside the payload, never in it, and none when absent', () => {
		for (const name of ['subscription-updated', 'checkout-completed']) {
			const r = normaliseStripeEvent(fixture(name));
			expect(r.kind === 'event' && r.event.environment, name).toBe('local');
			expect(r.kind === 'event' && JSON.stringify(r.event.payload), name).not.toContain('local');
		}
		const untagged = normaliseStripeEvent(fixture('subscription-deleted'));
		expect(untagged.kind === 'event' && 'environment' in untagged.event).toBe(false);
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

	it('reads the interval from the items’ prices: monthly Team, yearly Team (subscription-team-yearly)', () => {
		expect(normaliseStripeEvent(fixture('subscription-team-seats'))).toMatchObject({ event: { payload: { seats: 5, interval: 'month' } } });
		expect(normaliseStripeEvent(fixture('subscription-team-yearly'))).toMatchObject({
			kind: 'event',
			event: { type: 'subscription.updated', payload: { planCode: 'team', seats: 5, interval: 'year', externalRef: 'sub_synthetic_team_yearly_0001' } }
		});
	});

	it('sends a null interval when the prices aren’t a plain month or year, and none when the items carry no price', () => {
		const odd = (patch: (items: { price?: Record<string, unknown> }[]) => void) => {
			const e = fixture('subscription-team-seats');
			patch(e.data.object.items.data);
			const r = normaliseStripeEvent(e);
			if (r.kind !== 'event' || r.event.type !== 'subscription.updated') throw new Error('expected a subscription event');
			return r.event.payload;
		};
		expect(odd((items) => (items[0]!.price = { recurring: { interval: 'month', interval_count: 3 } })).interval).toBeNull();
		expect(odd((items) => (items[0]!.price = { recurring: { interval: 'week' } })).interval).toBeNull();
		expect(odd((items) => (items[0]!.price = { recurring: { interval: 'year' } })).interval).toBeNull();
		expect(odd((items) => (items[0]!.price = { id: 'price_one_off', recurring: null })).interval).toBeNull();
		const bare = odd((items) => items.forEach((i) => delete i.price));
		expect('interval' in bare).toBe(false);
		// The older fixtures carry no price: no interval, so app_billing_apply keeps the stored one.
		const r = normaliseStripeEvent(fixture('subscription-updated'));
		expect(r.kind === 'event' && 'interval' in r.event.payload).toBe(false);
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
			['account not a uuid', withSub('subscription-updated', { metadata: { billing_account_id: 'acct_1', plan_code: 'pro' } })],
			['unknown plan', withSub('subscription-updated', { metadata: { billing_account_id: ACCOUNT, plan_code: 'gold' } })],
			['unknown status', withSub('subscription-updated', { status: 'frozen' })],
			['no period', withSub('subscription-updated', { items: { data: [{ quantity: 1 }] } })],
			['no cancel flag', withSub('subscription-updated', { cancel_at_period_end: undefined })],
			['zero seats', withSub('subscription-updated', { items: { data: [{ quantity: 0, current_period_start: 1, current_period_end: 2 }] } })],
			['bad trial end', withSub('subscription-updated', { trial_end: 'soon' })],
			['bad created', { ...fixture('invoice-paid'), created: 'yesterday' }]
		];
		for (const [why, body] of bad) expect(normaliseStripeEvent(body).kind, why).toBe('invalid');
	});

	it('ignores a signed event about an object this app never made (no billing_account_id at all): a retry wouldn’t change it', () => {
		// A dashboard invoice (billing.md § Staff grants), a payment link's session, a subscription made by hand: answered
		// 200 ignored, not a 400 Stripe would redeliver for 3 days. A malformed account id is still invalid (above).
		const dashboardSub = withSub('subscription-updated', { metadata: { plan_code: 'pro' } });
		const failed = withSub('invoice-payment-failed', { parent: null, subscription_details: null, metadata: {} });
		const cases: [string, unknown][] = [
			['subscription without account', dashboardSub],
			['subscription without metadata', withSub('subscription-deleted', { metadata: undefined })],
			['checkout without account', withSub('checkout-completed', { metadata: {} })],
			['invoice without account', withSub('invoice-paid', { parent: null })],
			['failed invoice without account', failed]
		];
		for (const [why, body] of cases) expect(normaliseStripeEvent(body), why).toEqual({ kind: 'ignored', eventId: (body as { id: string }).id, type: (body as { type: string }).type });
	});
});

describe('a B2B invoice from the staff tool (no subscription)', () => {
	it('reads the account from the invoice’s own metadata, with no subscription; ignored with neither', () => {
		const e = fixture('invoice-paid');
		e.data.object = { id: 'in_b2b', object: 'invoice', parent: null, metadata: { billing_account_id: ACCOUNT, wm_invoice_key: 'k' } };
		expect(normaliseStripeEvent(e)).toMatchObject({ kind: 'event', event: { type: 'invoice.paid', payload: { accountId: ACCOUNT, externalRef: null } } });
		e.data.object = { id: 'in_b2b', object: 'invoice', parent: null, metadata: {} };
		expect(normaliseStripeEvent(e)).toMatchObject({ kind: 'ignored' });
	});

	const b2b = (metadata: Record<string, unknown>, over: Record<string, unknown> = {}) => {
		const e = fixture('invoice-paid');
		e.data.object = {
			id: 'in_b2b',
			object: 'invoice',
			parent: null,
			total: 1078800,
			currency: 'zar',
			metadata: { billing_account_id: ACCOUNT, plan_code: 'pro', seats: '1', interval: 'year', period_start: '1798754400', period_end: '1830290400', amount_minor: '1078800', wm_invoice_key: 'k', ...metadata },
			...over
		};
		return e;
	};

	it('a paid one carries the grant its metadata names (335): plan, seats, interval, period, and its own total and currency', () => {
		expect(normaliseStripeEvent(b2b({}))).toEqual({
			kind: 'event',
			event: {
				eventId: 'evt_synthetic_invoice_paid_0001',
				type: 'invoice.paid',
				payload: {
					accountId: ACCOUNT,
					externalRef: null,
					eventCreated: iso(1796209800),
					invoice: { ref: 'in_b2b', planCode: 'pro', seats: 1, interval: 'year', periodStart: iso(1798754400), periodEnd: iso(1830290400), totalMinor: 1078800, issuedMinor: 1078800, currency: 'zar' }
				}
			}
		});
	});

	it('a field that doesn’t parse is null, for the SQL to refuse; the event still names its account', () => {
		const r = normaliseStripeEvent(b2b({ seats: '2.5', period_start: 'soon', interval: 7, amount_minor: '-5' }, { total: '1078800' }));
		expect(r).toMatchObject({ kind: 'event', event: { payload: { accountId: ACCOUNT, invoice: { seats: null, periodStart: null, interval: null, totalMinor: null, issuedMinor: null, planCode: 'pro' } } } });
	});

	it('no grant on a subscription’s invoice, one without our key (a dashboard invoice), or a failed payment', () => {
		const sub = fixture('invoice-paid');
		Object.assign(sub.data.object, { total: 89900, currency: 'zar', metadata: { wm_invoice_key: 'k', plan_code: 'pro' } });
		const subPayload = normaliseStripeEvent(sub);
		expect(subPayload).toMatchObject({ kind: 'event', event: { payload: { externalRef: 'sub_synthetic_0001' } } });
		expect((subPayload as { event: { payload: object } }).event.payload).not.toHaveProperty('invoice');
		const dashboard = normaliseStripeEvent(b2b({ wm_invoice_key: undefined }));
		expect((dashboard as { event: { payload: object } }).event.payload).not.toHaveProperty('invoice');
		const failed = b2b({});
		failed.type = 'invoice.payment_failed';
		const f = normaliseStripeEvent(failed);
		expect(f).toMatchObject({ kind: 'event', event: { type: 'invoice.payment_failed' } });
		expect((f as { event: { payload: object } }).event.payload).not.toHaveProperty('invoice');
	});
});

describe('the subscription’s price (405, issue #928)', () => {
	const priceOfFixture = (name: string) => (normaliseStripeEvent(fixture(name)) as { event: { payload: { price?: unknown } } }).event.payload.price;

	it('sums every item’s unit_amount × quantity in their one currency', () => {
		expect(priceOfFixture('subscription-pro-priced')).toEqual({ totalMinor: 89900, currency: 'zar', discounted: false });
		expect(priceOfFixture('subscription-team-seats')).toEqual({ totalMinor: 249900 + 2 * 49900, currency: 'zar', discounted: false });
		expect(priceOfFixture('subscription-team-yearly')).toEqual({ totalMinor: 2499000 + 2 * 499000, currency: 'zar', discounted: false });
	});

	it('marks a coupon, in either of Stripe’s shapes', () => {
		expect(priceOfFixture('subscription-pro-coupon')).toMatchObject({ discounted: true });
		const e = fixture('subscription-pro-priced');
		e.data.object.discounts = ['di_synthetic_0002'];
		expect((normaliseStripeEvent(e) as { event: { payload: { price: unknown } } }).event.payload.price).toMatchObject({ discounted: true });
	});

	it('is unreadable (null total) for a price without unit_amount, a missing currency or items that disagree', () => {
		const tiered = fixture('subscription-pro-priced');
		delete tiered.data.object.items.data[0].price.unit_amount;
		const mixed = fixture('subscription-team-seats');
		mixed.data.object.items.data[0].price.currency = 'usd';
		const bare = fixture('subscription-team-seats');
		delete bare.data.object.items.data[1].price.currency;
		for (const e of [tiered, mixed, bare])
			expect((normaliseStripeEvent(e) as { event: { payload: { price: unknown } } }).event.payload.price).toEqual({ totalMinor: null, currency: null, discounted: false });
	});

	it('is absent when no item carries a price (the older fixtures), so nothing is checked', () => {
		expect(priceOfFixture('subscription-updated')).toBeUndefined();
	});
});
