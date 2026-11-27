// POST /billing/webhook/:provider without a database (webhook.ts), through the
// real app: which provider answers, the signature and payload checks, the body
// cap, the no-user transaction, each app_billing_apply result's answer, and
// that nothing logged carries the payload or the secret. Against Postgres and
// 326's app_billing_apply: webhook.db.test.ts.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signPayload } from './provider/signature.js';

const { calls, answer, logs } = vi.hoisted(() => ({
	calls: [] as { user: string | null; sql: string; params: unknown[] }[],
	answer: { result: 'applied' as unknown, error: null as Error | null, claimed: false },
	logs: [] as { level: string; fields: Record<string, unknown> }[]
}));

vi.mock('../db/tx.js', async (orig) => ({
	...(await orig<typeof import('../db/tx.js')>()),
	withUser: async () => {
		throw new Error('the webhook must not run as a user');
	},
	withoutUser: async (fn: (d: unknown) => unknown) =>
		fn({
			query: async (sql: string, params: unknown[] = []) => {
				calls.push({ user: null, sql, params });
				if (answer.error) throw answer.error;
				if (sql.includes('app_billing_orphan_claim')) return { rows: [{ claimed: answer.claimed }] };
				if (sql.includes('app_billing_orphan_done')) return { rows: [{ app_billing_orphan_done: true }] };
				return { rows: [{ result: answer.result }] };
			}
		})
}));
vi.mock('../logging/logEvent.js', async (orig) => ({
	...(await orig<typeof import('../logging/logEvent.js')>()),
	logEvent: (level: string, fields: Record<string, unknown>) => logs.push({ level, fields })
}));

const { createApp } = await import('../app.js');
const { WEBHOOK_BODY_MAX } = await import('./webhook.js');
const app = createApp();

const SECRET = 'test-only-billing-secret-0000000000000000';
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/billing/${name}.json`, import.meta.url), 'utf8');
const post = (provider: string, body: string, header: string | null = signPayload(SECRET, body, Date.now() / 1000)) =>
	app.request(`/billing/webhook/${provider}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'stripe-signature': header }) },
		body
	});

beforeEach(() => {
	vi.stubEnv('BILLING_PROVIDER', 'stripe');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
});
afterEach(() => {
	calls.length = 0;
	logs.length = 0;
	answer.result = 'applied';
	answer.error = null;
	answer.claimed = false;
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('POST /billing/webhook/:provider', () => {
	it('applies a signed subscription event through app_billing_apply, with no user, and answers 200 (positive control)', async () => {
		const res = await post('stripe', fixture('subscription-updated'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true, result: 'applied' });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.sql).toMatch(/SELECT app_billing_apply\(\$1, \$2, \$3, \$4::jsonb\)/);
		const [provider, eventId, type, payload] = calls[0]!.params as [string, string, string, string];
		expect([provider, eventId, type]).toEqual(['stripe', 'evt_synthetic_sub_updated_0001', 'subscription.updated']);
		expect(JSON.parse(payload)).toMatchObject({ accountId: '00000000-0000-4000-8000-000000000641', planCode: 'pro', status: 'active', externalRef: 'sub_synthetic_0001' });
	});

	it('the mock answers on /mock with the same scheme when it is the provider', async () => {
		vi.stubEnv('BILLING_PROVIDER', 'mock');
		expect((await post('mock', fixture('invoice-paid'))).status).toBe(200);
		expect(calls[0]!.params.slice(0, 3)).toEqual(['mock', 'evt_synthetic_invoice_paid_0001', 'invoice.paid']);
	});

	it('is 404, before reading the body, for a provider that isn’t the configured one, for manual, and for a name that isn’t ours', async () => {
		const body = fixture('subscription-updated');
		for (const [configured, path] of [
			['stripe', 'mock'],
			['stripe', 'manual'],
			['stripe', 'paystack'],
			['mock', 'stripe'],
			['manual', 'manual'],
			['stripe_billing', 'stripe_billing'],
			['stripe_billing', 'mock']
		]) {
			vi.stubEnv('BILLING_PROVIDER', configured!);
			const res = await post(path!, body);
			expect(res.status, `${configured} ${path}`).toBe(404);
			expect(await res.json()).toEqual({ error: 'not found' });
		}
		expect(calls).toHaveLength(0);
	});

	it('is 400 with a fixed message for a bad, stale or missing signature, and calls nothing', async () => {
		const body = fixture('subscription-updated');
		for (const header of [null, 'garbage', signPayload('another-secret', body, Date.now() / 1000), signPayload(SECRET, body, Date.now() / 1000 - 600)]) {
			const res = await post('stripe', body, header);
			expect(res.status, String(header)).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid signature' });
		}
		// Signed over other bytes than those sent.
		const res = await post('stripe', `${body}\n`, signPayload(SECRET, body, Date.now() / 1000));
		expect(res.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it('is 400 "invalid event" for a signed body it can’t normalise', async () => {
		// Ours (it names an account) but missing its plan and period.
		const bad = JSON.stringify({ ...JSON.parse(fixture('subscription-updated')), data: { object: { id: 'sub_1', metadata: { billing_account_id: '00000000-0000-4000-8000-000000000641' } } } });
		const res = await post('stripe', bad);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid event' });
		expect(calls).toHaveLength(0);
	});

	it('answers 200 "ignored" for a signed invoice this app never made (no billing_account_id), without a database call', async () => {
		// A dashboard invoice: a 400 would have Stripe redeliver it for 3 days, and no retry could change it.
		const e = JSON.parse(fixture('invoice-payment-failed'));
		e.data.object = { id: 'in_dashboard', object: 'invoice', parent: null, metadata: {} };
		const res = await post('stripe', JSON.stringify(e));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true, result: 'ignored' });
		expect(calls).toHaveLength(0);
	});

	it('answers 200 "ignored" for a signed type it doesn’t act on, without a database call', async () => {
		const res = await post('stripe', '{"id":"evt_x","type":"customer.created","data":{"object":{}}}');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true, result: 'ignored' });
		expect(calls).toHaveLength(0);
	});

	it('answers each app_billing_apply result per the contract: 200 for applied, recorded, duplicate, stale, conflict, unknown_account; 400 for invalid', async () => {
		for (const [result, status] of [
			['applied', 200],
			['recorded', 200],
			['duplicate', 200],
			['stale', 200],
			['conflict', 200],
			['unknown_account', 200],
			['invalid', 400]
		] as const) {
			answer.result = result;
			const res = await post('stripe', fixture('subscription-updated'));
			expect(res.status, result).toBe(status);
			expect(await res.json(), result).toEqual(status === 200 ? { received: true, result } : { error: 'invalid event' });
		}
		// conflict and unknown_account are warnings the operator reads; applied is info.
		expect(logs.filter((l) => l.fields.event === 'billing_webhook').map((l) => [l.fields.result, l.level])).toEqual([
			['applied', 'info'],
			['recorded', 'info'],
			['duplicate', 'info'],
			['stale', 'info'],
			['conflict', 'warn'],
			['unknown_account', 'warn'],
			['invalid', 'warn']
		]);
	});

	it('is the app’s 500, with no internal text, when the database fails or answers something unknown', async () => {
		answer.error = new Error('relation "billing_event" does not exist');
		let res = await post('stripe', fixture('subscription-updated'));
		expect(res.status).toBe(500);
		expect(await res.text()).not.toMatch(/billing_event|relation/);
		answer.error = null;
		answer.result = 'something new';
		res = await post('stripe', fixture('subscription-updated'));
		expect(res.status).toBe(500);
		expect(await res.text()).not.toMatch(/app_billing_apply|something new/);
	});

	it('refuses a body over the cap with 413', async () => {
		const res = await post('stripe', `{"pad":"${'x'.repeat(WEBHOOK_BODY_MAX)}"}`);
		expect(res.status).toBe(413);
		expect(calls).toHaveLength(0);
	});

	it('logs provider, type, event id and result, never the payload or the secret', async () => {
		const body = fixture('subscription-updated');
		await post('stripe', body);
		await post('stripe', body, 'bad');
		const text = JSON.stringify(logs);
		expect(logs.some((l) => l.fields.event === 'billing_webhook' && l.fields.eventId === 'evt_synthetic_sub_updated_0001' && l.fields.type === 'subscription.updated')).toBe(true);
		for (const leak of [SECRET, '00000000-0000-4000-8000-000000000641', 'sub_synthetic_0001', 'plan_code']) expect(text).not.toContain(leak);
	});

	describe('an orphan: a live subscription or a completed checkout whose account is gone (352)', () => {
		/** Stripe answering the orphan's cancel and refund (stripeApi.ts orphanCancelAndRefund), or failing every call with `failStatus`. */
		/** A fixture with a Stripe-shaped subscription id (letters and digits after sub_; the synthetic one's underscores aren't). */
		const orphanFixture = (name: string) => fixture(name).replaceAll('sub_synthetic_0001', 'sub_Synthetic0001');
		/** `ended`: Stripe has it canceled with no paid first invoice inside the refund window (a late event about an old one). */
		function stripe(failStatus?: number, ended = false) {
			const seen: string[] = [];
			vi.stubEnv('STRIPE_SECRET_KEY', 'test-only-not-a-stripe-key');
			vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
				const path = new URL(String(url)).pathname;
				seen.push(`${init?.method} ${path}`);
				if (failStatus) return new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: failStatus });
				const body =
					path === '/v1/invoices'
						? {
								data: ended
									? []
									: [{ id: 'in_Orph1', amount_paid: 4900, billing_reason: 'subscription_create', status_transitions: { paid_at: Math.floor(Date.now() / 1000) - 60 } }]
							}
						: path === '/v1/invoice_payments'
							? { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_Orph1' } }] }
							: path === '/v1/refunds'
								? { amount: 4900, status: 'succeeded' }
								: { status: init?.method === 'DELETE' || ended ? 'canceled' : 'active' };
				return new Response(JSON.stringify(body), { status: 200 });
			});
			return seen;
		}

		it('claims the event in the apply transaction, cancels and refunds at Stripe, marks it done and answers 200 orphan_refunded', async () => {
			const seen = stripe();
			answer.result = 'unknown_account';
			answer.claimed = true;
			const res = await post('stripe', orphanFixture('subscription-updated'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ received: true, result: 'orphan_refunded' });
			expect(calls.map((c) => c.sql.match(/app_billing_\w+/)![0])).toEqual(['app_billing_apply', 'app_billing_orphan_claim', 'app_billing_orphan_done']);
			// First delivery: the claim may turn the row pending.
			expect(calls[1]!.params).toEqual(['stripe', 'evt_synthetic_sub_updated_0001', true]);
			expect(seen).toEqual(['GET /v1/subscriptions/sub_Synthetic0001', 'GET /v1/invoices', 'DELETE /v1/subscriptions/sub_Synthetic0001', 'GET /v1/invoice_payments', 'POST /v1/refunds']);
			expect(calls[2]!.params).toEqual(['stripe', 'evt_synthetic_sub_updated_0001', 'orphan_refunded']);
			const line = logs.find((l) => l.fields.result === 'orphan_refunded')!;
			expect(line.level).toBe('warn');
			expect(line.fields).toMatchObject({ event: 'billing_webhook', eventId: 'evt_synthetic_sub_updated_0001', cancelled: true, refunds: 1, refundedMinor: 4900 });
			for (const leak of ['00000000-0000-4000-8000-000000000641', 'sub_Synthetic0001', '@']) expect(JSON.stringify(logs)).not.toContain(leak);
		});

		it('a redelivery (duplicate) asks whether the row is still pending, never claiming it afresh', async () => {
			stripe();
			answer.result = 'duplicate';
			answer.claimed = true;
			expect(await (await post('stripe', orphanFixture('subscription-updated'))).json()).toEqual({ received: true, result: 'orphan_refunded' });
			expect(calls[1]!.params).toEqual(['stripe', 'evt_synthetic_sub_updated_0001', false]);
			calls.length = 0;
			answer.claimed = false; // done already: a plain duplicate, nothing asked of Stripe
			const seen = stripe();
			expect(await (await post('stripe', orphanFixture('subscription-updated'))).json()).toEqual({ received: true, result: 'duplicate' });
			expect(seen).toEqual([]);
		});

		it('a completed checkout recorded with no account is an orphan too; one for a known account is not', async () => {
			const seen = stripe();
			answer.result = 'recorded';
			answer.claimed = true;
			expect(await (await post('stripe', orphanFixture('checkout-completed'))).json()).toEqual({ received: true, result: 'orphan_refunded' });
			expect(seen[0]).toMatch(/^GET \/v1\/subscriptions\/sub_/);
			calls.length = 0;
			seen.length = 0;
			answer.claimed = false; // the SQL found the account (positive control)
			expect(await (await post('stripe', orphanFixture('checkout-completed'))).json()).toEqual({ received: true, result: 'recorded' });
			expect(seen).toEqual([]);
		});

		it('asks nothing for an ended subscription, an unknown account’s delete, or a known account’s applied update', async () => {
			const seen = stripe();
			answer.result = 'unknown_account';
			answer.claimed = true;
			for (const name of ['subscription-deleted']) {
				expect(await (await post('stripe', orphanFixture(name))).json()).toEqual({ received: true, result: 'unknown_account' });
			}
			answer.result = 'applied';
			expect(await (await post('stripe', orphanFixture('subscription-updated'))).json()).toEqual({ received: true, result: 'applied' });
			expect(calls.every((c) => c.sql.includes('app_billing_apply'))).toBe(true);
			expect(seen).toEqual([]);
		});

		it('leaves an ended subscription whose first invoice is past the refund window alone: records orphan_skipped_old and answers 200, cancelling and refunding nothing', async () => {
			const seen = stripe(undefined, true);
			answer.result = 'unknown_account';
			answer.claimed = true;
			const res = await post('stripe', orphanFixture('subscription-updated'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ received: true, result: 'orphan_skipped_old' });
			expect(seen).toEqual(['GET /v1/subscriptions/sub_Synthetic0001', 'GET /v1/invoices']);
			expect(calls.at(-1)!.params).toEqual(['stripe', 'evt_synthetic_sub_updated_0001', 'orphan_skipped_old']);
			expect(logs.find((l) => l.fields.result === 'orphan_skipped_old')?.fields).toMatchObject({ cancelled: false, refunds: 0, refundedMinor: 0 });
		});

		it('acts only on what this deployment sold: another deployment’s tag, or none, is logged and answered as applied, with no claim and nothing asked of Stripe', async () => {
			answer.result = 'unknown_account';
			answer.claimed = true;
			const untagged = orphanFixture('subscription-updated').replace(', "wm_environment": "local"', '');
			expect(untagged).not.toContain('wm_environment');
			for (const [env, body] of [
				['icwbt.example.com', orphanFixture('subscription-updated')],
				[undefined, untagged]
			] as const) {
				if (env) vi.stubEnv('BILLING_ENVIRONMENT', env);
				const seen = stripe();
				calls.length = 0;
				logs.length = 0;
				const res = await post('stripe', body);
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ received: true, result: 'unknown_account' });
				expect(calls.map((c) => c.sql.match(/app_billing_\w+/)![0])).toEqual(['app_billing_apply']);
				expect(seen).toEqual([]);
				expect(logs.find((l) => l.fields.orphan === 'other_environment')?.level).toBe('warn');
				vi.unstubAllEnvs();
				vi.stubEnv('BILLING_PROVIDER', 'stripe');
				vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
			}
			// Positive control: this deployment's own tag (the local default) is an orphan, as above.
			vi.stubEnv('BILLING_ENVIRONMENT', 'icwbt.example.com');
			stripe();
			const ours = orphanFixture('subscription-updated').replace('"wm_environment": "local"', '"wm_environment": "icwbt.example.com"');
			expect(await (await post('stripe', ours)).json()).toEqual({ received: true, result: 'orphan_refunded' });
		});

		it('logs where a failed orphan stopped: the step and Stripe’s status and code, never its message or payload', async () => {
			stripe(402);
			answer.result = 'unknown_account';
			answer.claimed = true;
			expect((await post('stripe', orphanFixture('subscription-updated'))).status).toBe(503);
			const line = logs.find((l) => l.fields.result === 'orphan_failed')!;
			expect(line.fields).toMatchObject({ step: 'read', status: 402, code: null });
			expect(JSON.stringify(line)).not.toMatch(/Stripe answered|api_error|test-only-not-a-stripe-key/);
		});

		it('answers 503 (so Stripe retries) and leaves the row pending when the cancel or refund fails, or Stripe has no key', async () => {
			stripe(500);
			answer.result = 'unknown_account';
			answer.claimed = true;
			let res = await post('stripe', orphanFixture('subscription-updated'));
			expect(res.status).toBe(503);
			expect(await res.text()).not.toMatch(/api_error|Stripe answered/);
			expect(calls.some((c) => c.sql.includes('app_billing_orphan_done'))).toBe(false);
			expect(logs.find((l) => l.fields.result === 'orphan_failed')?.level).toBe('error');
			vi.stubEnv('STRIPE_SECRET_KEY', '');
			res = await post('stripe', orphanFixture('subscription-updated'));
			expect(res.status).toBe(503);
		});
	});
});
