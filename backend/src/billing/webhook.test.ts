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
	answer: { result: 'applied' as unknown, error: null as Error | null },
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
	vi.unstubAllEnvs();
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
		const bad = JSON.stringify({ ...JSON.parse(fixture('subscription-updated')), data: { object: { id: 'sub_1' } } });
		const res = await post('stripe', bad);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid event' });
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
});
