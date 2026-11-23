// The mock provider's checkout and portal (issue #641 Phase 3, "Local-first";
// docs/billing.md § Checkout and portal). Pure: no I/O.
//
// A mock checkout or portal "session" is a signed token, not a row: the
// account, the plan and interval (checkout) or the subscription to change
// (portal), the return URLs and an expiry, signed with HMAC-SHA256 under the
// dev-only BILLING_WEBHOOK_SECRET with its own context string, so a token is
// never mistaken for a webhook signature and a page can't be pointed at
// another account. The pages (billing/mockCheckout.ts) turn the person's
// choice into Stripe-shaped events, signed with the same dev key and posted
// to the real webhook route, so app_billing_apply is the only writer, as with
// Stripe.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { signPayload } from './signature.js';

/** How long a mock session lasts (Stripe's Checkout sessions last 24 h; an hour is plenty locally). */
export const MOCK_SESSION_TTL_SECONDS = 3600;

export type MockSession =
	| { kind: 'checkout'; accountId: string; planCode: string; planName: string; amountMinor: number; currency: string; interval: 'month' | 'year'; successUrl: string; cancelUrl: string; exp: number }
	| {
			kind: 'portal';
			accountId: string;
			returnUrl: string;
			/** The live subscription to offer to cancel, when there is one (the mock's own: external ref sub_mock_…). */
			subscription: { planCode: string; planName?: string; status: string; periodStart: string; periodEnd: string; cancelAtPeriodEnd: boolean; seats: number } | null;
			exp: number;
	  };

const CONTEXT = 'wm-mock-billing-session.';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const mac = (secret: string, payload: string) => createHmac('sha256', secret).update(CONTEXT + payload, 'utf8').digest('base64url');

export function signMockSession(secret: string, session: MockSession): string {
	const payload = b64(JSON.stringify(session));
	return `${payload}.${mac(secret, payload)}`;
}

/** The session a token carries, or null when it is forged, malformed or expired. */
export function readMockSession(secret: string | undefined, token: string | undefined | null, nowMs = Date.now()): MockSession | null {
	if (!secret || !token || token.length > 8192) return null;
	const dot = token.indexOf('.');
	if (dot < 1) return null;
	const payload = token.slice(0, dot);
	const given = Buffer.from(token.slice(dot + 1), 'base64url');
	const expected = Buffer.from(mac(secret, payload), 'base64url');
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	let s: MockSession;
	try {
		s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MockSession;
	} catch {
		return null;
	}
	if (typeof s?.exp !== 'number' || s.exp * 1000 < nowMs) return null;
	return s;
}

/** The mock's subscription id for an account: one per account, so a second "pays" updates it rather than making another. */
export const mockSubscriptionRef = (accountId: string) => `sub_mock_${accountId.replace(/-/g, '')}`;

const eventId = () => `evt_mock_${randomBytes(12).toString('hex')}`;

function addInterval(start: Date, interval: 'month' | 'year'): Date {
	const d = new Date(start);
	if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
	else d.setUTCMonth(d.getUTCMonth() + 1);
	return d;
}

const secs = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

function subscriptionObject(
	accountId: string,
	planCode: string,
	status: string,
	start: number,
	end: number,
	cancelAtPeriodEnd: boolean,
	seats: number
): Record<string, unknown> {
	return {
		id: mockSubscriptionRef(accountId),
		object: 'subscription',
		status,
		cancel_at_period_end: cancelAtPeriodEnd,
		trial_end: null,
		metadata: { billing_account_id: accountId, plan_code: planCode },
		items: { object: 'list', data: [{ object: 'subscription_item', quantity: seats, current_period_start: start, current_period_end: end }] }
	};
}

/** The events Stripe sends when a Checkout session is paid: the session completed, then the subscription created (active). */
export function paidEvents(s: Extract<MockSession, { kind: 'checkout' }>, nowMs = Date.now()): Record<string, unknown>[] {
	const now = new Date(nowMs);
	const created = secs(now);
	const sub = subscriptionObject(s.accountId, s.planCode, 'active', created, secs(addInterval(now, s.interval)), false, 1);
	return [
		{
			id: eventId(),
			object: 'event',
			type: 'checkout.session.completed',
			created,
			data: { object: { id: `cs_mock_${randomBytes(12).toString('hex')}`, object: 'checkout.session', mode: 'subscription', subscription: sub.id, metadata: sub.metadata } }
		},
		{ id: eventId(), object: 'event', type: 'customer.subscription.created', created, data: { object: sub } }
	];
}

/** The event Stripe sends when the portal cancels at the period end: the subscription updated, still live until then. */
export function cancelAtPeriodEndEvent(s: Extract<MockSession, { kind: 'portal' }>, nowMs = Date.now()): Record<string, unknown> | null {
	const sub = s.subscription;
	if (!sub) return null;
	return {
		id: eventId(),
		object: 'event',
		type: 'customer.subscription.updated',
		created: secs(new Date(nowMs)),
		data: { object: subscriptionObject(s.accountId, sub.planCode, sub.status, secs(sub.periodStart), secs(sub.periodEnd), true, sub.seats) }
	};
}

/** One event as the webhook receives it: the raw body and its Stripe-Signature, signed with the dev key now. */
export function signedDelivery(secret: string, event: Record<string, unknown>, nowMs = Date.now()): { body: string; signature: string } {
	const body = JSON.stringify(event);
	return { body, signature: signPayload(secret, body, Math.floor(nowMs / 1000)) };
}
