// Checkout, the portal and the mock's pages without a database (routes.ts,
// mockCheckout.ts), through the real app: the session gate, the 404s, which
// plan each account may buy, the coded refusals, and that the mock's "pays"
// posts signed events to the real webhook route. Who may act for which
// account, and the subscription a mock payment leaves, need Postgres:
// billing/checkout.db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { answers, queries } = vi.hoisted(() => ({
	answers: new Map<string, unknown>(),
	queries: [] as { sql: string; params: unknown[] }[]
}));

const db = {
	query: async (sql: string, params: unknown[] = []) => {
		queries.push({ sql, params });
		const fn = /app_\w+/.exec(sql)?.[0] ?? '';
		return { rows: (answers.get(fn) as unknown[]) ?? [] };
	}
};
vi.mock('../db/tx.js', async (orig) => ({
	...(await orig<typeof import('../db/tx.js')>()),
	withUser: async (_u: string, fn: (d: unknown) => unknown) => fn(db),
	withoutUser: async (fn: (d: unknown) => unknown) => fn(db)
}));
vi.mock('../auth/middleware.js', async (orig) => {
	const real = await orig<typeof import('../auth/middleware.js')>();
	return {
		...real,
		requireUser: async (c: Parameters<typeof real.requireUser>[0], next: Parameters<typeof real.requireUser>[1]) => {
			const u = c.req.header('x-test-user');
			if (!u) return c.json({ error: 'unauthorized' }, 401);
			c.set('userId', u);
			return next();
		}
	};
});

const { createApp } = await import('../app.js');
const { signMockSession } = await import('./provider/mock.js');
const app = createApp();

const SECRET = 'test-only-billing-secret-0000000000000000';
const U = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const planOf = (kind: 'user' | 'team', subscription: unknown = null) => ({ account: { id: A, kind }, plan: { code: 'free', name: 'Free' }, subscription, usage: {} });
const PLANS = [
	{ p: { code: 'free', name: 'Free', price_monthly_minor: 0, price_annual_minor: 0, currency: 'ZAR', limits: {}, features: {}, trial_days: 0, active: true } },
	{ p: { code: 'pro', name: 'Pro', price_monthly_minor: 89900, price_annual_minor: 899000, currency: 'ZAR', limits: { seats_included: 1 }, features: {}, trial_days: 14, active: true } },
	{
		p: {
			code: 'team',
			name: 'Team',
			price_monthly_minor: 249900,
			price_annual_minor: 2499000,
			currency: 'ZAR',
			limits: { seats_included: 3 },
			features: { extra_seat_monthly_minor: 49900, extra_seat_annual_minor: 499000 },
			trial_days: 30,
			active: true
		}
	}
];
const post = (path: string, body?: unknown, user: string | null = U) =>
	app.request(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});

beforeEach(() => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
	vi.stubEnv('SITE_URL', 'http://site.test');
	answers.set('app_my_billing_account', [{ id: A }]);
	answers.set('app_account_plan', [{ plan: planOf('user') }]);
	answers.set('app_billing_customer_ref', [{ ref: null }]);
	answers.set('app_billing_plans', PLANS);
});
afterEach(() => {
	answers.clear();
	queries.length = 0;
	vi.unstubAllEnvs();
});

describe('POST /account/plan/checkout', () => {
	it('is 401 without a session, before any query', async () => {
		expect((await post('/account/plan/checkout', { plan: 'pro', interval: 'month' }, null)).status).toBe(401);
		expect(queries).toEqual([]);
	});

	it('answers the mock’s page for Pro, coming back to the plan page', async () => {
		const res = await post('/account/plan/checkout', { plan: 'pro', interval: 'month' });
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const { url } = (await res.json()) as { url: string };
		expect(url).toMatch(/^http:\/\/localhost\/billing\/mock\/checkout\?t=/);
		const page = await app.request(url);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('Subscribe to Pro');
		expect(html).toContain('ZAR 899.00 a month');
		for (const o of ['pays', 'declines', 'cancels']) expect(html).toContain(`data-outcome="${o}">Simulate: ${o}</button>`);
		expect(html).not.toContain(SECRET);
	});

	it('refuses the wrong plan for the account (a person buys Pro, a team Team) and a bad body', async () => {
		expect((await post('/account/plan/checkout', { plan: 'team', interval: 'month' })).status).toBe(400);
		expect((await post('/account/plan/checkout', { plan: 'free', interval: 'month' })).status).toBe(400);
		expect((await post('/account/plan/checkout', { plan: 'pro', interval: 'week' })).status).toBe(400);
		expect((await post('/account/plan/checkout', { plan: 'pro', interval: 'month', price: 1 })).status).toBe(400);
	});

	it('refuses a second subscription: the portal changes the one there is', async () => {
		answers.set('app_account_plan', [{ plan: planOf('user', { status: 'active', seats: 1, periodStart: null, periodEnd: null, trialEnd: null, cancelAtPeriodEnd: false }) }]);
		expect((await post('/account/plan/checkout', { plan: 'pro', interval: 'month' })).status).toBe(409);
	});

	it('manual: 409 billing_unavailable', async () => {
		vi.stubEnv('BILLING_PROVIDER', 'manual');
		const res = await post('/account/plan/checkout', { plan: 'pro', interval: 'month' });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: 'billing_unavailable' });
	});

	it('stripe with no key: 503 billing_provider_error, no provider text', async () => {
		vi.stubEnv('BILLING_PROVIDER', 'stripe');
		vi.stubEnv('STRIPE_SECRET_KEY', '');
		const res = await post('/account/plan/checkout', { plan: 'pro', interval: 'month' });
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: 'billing_provider_error' });
	});
});

describe('POST /teams/:id/plan/checkout and /portal', () => {
	it('is 404 to anyone but a team admin (app_team_billing_account answers null), and for a malformed id', async () => {
		answers.set('app_team_billing_account', [{ id: null }]);
		expect((await post(`/teams/${T}/plan/checkout`, { plan: 'team', interval: 'month' })).status).toBe(404);
		expect((await post(`/teams/${T}/plan/portal`)).status).toBe(404);
		expect((await post('/teams/not-a-uuid/plan/checkout', { plan: 'team', interval: 'month' })).status).toBe(404);
	});

	it('404 comes before the provider: a stranger learns nothing even when billing is manual', async () => {
		vi.stubEnv('BILLING_PROVIDER', 'manual');
		answers.set('app_team_billing_account', [{ id: null }]);
		expect((await post(`/teams/${T}/plan/checkout`, { plan: 'team', interval: 'month' })).status).toBe(404);
	});

	it('an admin buys Team, coming back to the team’s plan page', async () => {
		answers.set('app_team_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: planOf('team') }]);
		expect((await post(`/teams/${T}/plan/checkout`, { plan: 'pro', interval: 'month' })).status).toBe(400);
		const res = await post(`/teams/${T}/plan/checkout`, { plan: 'team', interval: 'year' });
		expect(res.status).toBe(200);
		const t = new URL(((await res.json()) as { url: string }).url).searchParams.get('t')!;
		const payload = JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString());
		expect(payload).toMatchObject({ planCode: 'team', interval: 'year', amountMinor: 2499000, seats: 3, seatsIncluded: 3, successUrl: `http://site.test/teams/${T}/plan?checkout=done` });
	});

	const tokenPayload = async (res: Response) => {
		const t = new URL(((await res.json()) as { url: string }).url).searchParams.get('t')!;
		return JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
	};

	it('sells Team’s extra seats: 5 seats is the base plus 2 at the extra-seat price, shown on the mock’s page', async () => {
		answers.set('app_team_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: planOf('team') }]);
		const res = await post(`/teams/${T}/plan/checkout`, { plan: 'team', interval: 'month', seats: 5 });
		expect(res.status).toBe(200);
		const payload = await tokenPayload(res.clone());
		expect(payload).toMatchObject({ seats: 5, seatsIncluded: 3, extraSeatMinor: 49900, amountMinor: 249900 + 2 * 49900 });
		const html = await (await app.request(((await res.json()) as { url: string }).url)).text();
		expect(html).toContain('ZAR 3497.00 a month');
		expect(html).toContain('data-mock-seats="5">5 editor seats: 3 included and 2 extra at ZAR 499.00 each.');
		const year = await tokenPayload(await post(`/teams/${T}/plan/checkout`, { plan: 'team', interval: 'year', seats: 4 }));
		expect(year).toMatchObject({ seats: 4, amountMinor: 2499000 + 499000 });
	});

	it('refuses seats under the included ones, past the maximum, or not a whole number', async () => {
		answers.set('app_team_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: planOf('team') }]);
		for (const seats of [2, 0, 51, 3.5, '5']) expect((await post(`/teams/${T}/plan/checkout`, { plan: 'team', interval: 'month', seats })).status, String(seats)).toBe(400);
		expect((await post(`/teams/${T}/plan/checkout`, { plan: 'team', interval: 'month', seats: 50 })).status).toBe(200);
	});
});

describe('checkout seats on Pro', () => {
	it('takes 1 (its one seat) and refuses more: Pro sells no extra seats', async () => {
		expect((await post('/account/plan/checkout', { plan: 'pro', interval: 'month', seats: 1 })).status).toBe(200);
		const res = await post('/account/plan/checkout', { plan: 'pro', interval: 'month', seats: 2 });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'the Pro plan has 1 seat and sells no extra ones' });
	});
});

describe('POST /account/plan/portal', () => {
	it('answers the mock’s portal page', async () => {
		const res = await post('/account/plan/portal');
		expect(res.status).toBe(200);
		const { url } = (await res.json()) as { url: string };
		const page = await app.request(url);
		expect(await page.text()).toContain('data-mock-subscription="none"');
	});

	it('names the plan, not its code, on the mock’s portal page', async () => {
		const sub = { status: 'active', periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false, seats: 1 };
		answers.set('app_account_plan', [{ plan: { ...planOf('user', sub), plan: { code: 'pro', name: 'Pro' } } }]);
		const { url } = (await (await post('/account/plan/portal')).json()) as { url: string };
		const html = await (await app.request(url)).text();
		expect(html).toContain('Your Pro subscription renews on 2026-12-01.');
		expect(html).not.toContain('Your pro subscription');
		expect(html).toContain('href="http://site.test/account/plan" data-action="return"');
	});
});

describe('the mock pages', () => {
	const token = (over: Record<string, unknown> = {}) =>
		signMockSession(SECRET, {
			kind: 'checkout',
			accountId: A,
			planCode: 'pro',
			planName: 'Pro',
			amountMinor: 89900,
			currency: 'ZAR',
			interval: 'month',
			successUrl: 'http://site.test/account/plan?checkout=done',
			cancelUrl: 'http://site.test/account/plan?checkout=cancelled',
			exp: Math.floor(Date.now() / 1000) + 600,
			...over
		} as never);
	const form = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } };

	it('are 404 unless the provider is the mock, and for a forged, expired or other-kind token', async () => {
		vi.stubEnv('BILLING_PROVIDER', 'manual');
		expect((await app.request(`/billing/mock/checkout?t=${token()}`)).status).toBe(404);
		vi.stubEnv('BILLING_PROVIDER', 'mock');
		expect((await app.request(`/billing/mock/checkout?t=${token()}x`)).status).toBe(404);
		expect((await app.request(`/billing/mock/checkout?t=${token({ exp: 1 })}`)).status).toBe(404);
		expect((await app.request(`/billing/mock/portal?t=${token()}`)).status).toBe(404);
	});

	it('the expired page links back to the plan page', async () => {
		const res = await app.request(`/billing/mock/checkout?t=${token({ exp: 1 })}`);
		expect(res.status).toBe(404);
		const html = await res.text();
		expect(html).toContain('This page has expired');
		expect(html).toContain('<a href="http://site.test/account/plan" data-action="return">Back to the plan page</a>');
	});

	it('cancels: back to the plan page, nothing posted', async () => {
		const res = await app.request(`/billing/mock/checkout?t=${token()}&outcome=cancels`, form);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('http://site.test/account/plan?checkout=cancelled');
		expect(queries.some((q) => q.sql.includes('app_billing_apply'))).toBe(false);
	});

	it('declines: the page again, saying so, nothing posted', async () => {
		const res = await app.request(`/billing/mock/checkout?t=${token()}&outcome=declines`, form);
		expect(res.status).toBe(402);
		expect(await res.text()).toContain('data-mock-declined');
		expect(queries.some((q) => q.sql.includes('app_billing_apply'))).toBe(false);
	});

	it('pays: two signed events through the real webhook route, then back to the plan page', async () => {
		answers.set('app_billing_apply', [{ result: 'applied' }]);
		const res = await app.request(`/billing/mock/checkout?t=${token()}&outcome=pays`, form);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('http://site.test/account/plan?checkout=done');
		const applied = queries.filter((q) => q.sql.includes('app_billing_apply'));
		expect(applied.map((q) => [q.params[0], q.params[2]])).toEqual([
			['mock', 'checkout.completed'],
			['mock', 'subscription.updated']
		]);
		expect(JSON.parse(String(applied[1]!.params[3]))).toMatchObject({ accountId: A, planCode: 'pro', status: 'active' });
	});

	it('pays, but the webhook refuses: 502, not a redirect that pretends it worked', async () => {
		answers.set('app_billing_apply', [{ result: 'invalid' }]);
		const res = await app.request(`/billing/mock/checkout?t=${token()}&outcome=pays`, form);
		expect(res.status).toBe(502);
		const html = await res.text();
		expect(html).toContain('Something went wrong');
		// Back to the plan page the checkout came from, without its ?checkout= outcome.
		expect(html).toContain('<a href="http://site.test/account/plan" data-action="return">Back to the plan page</a>');
	});

	it('a team’s failed page links back to the team’s plan page', async () => {
		answers.set('app_billing_apply', [{ result: 'invalid' }]);
		const back = 'http://site.test/teams/33333333-3333-4333-8333-333333333333/plan';
		const res = await app.request(`/billing/mock/checkout?t=${token({ successUrl: `${back}?checkout=done`, cancelUrl: `${back}?checkout=cancelled` })}&outcome=pays`, form);
		expect(res.status).toBe(502);
		expect(await res.text()).toContain(`<a href="${back}" data-action="return">`);
	});

	it('refuses an unknown outcome', async () => {
		expect((await app.request(`/billing/mock/checkout?t=${token()}&outcome=steals`, form)).status).toBe(400);
	});
});
