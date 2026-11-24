// POST /teams/:id/plan/seats without a database (routes.ts; issue #641 Phase 5,
// docs/billing.md § Changing a Team's seats): the session gate, the 404 before
// any provider call, the live-Team-subscription 409s (a grant's coded), the
// manual provider's refusal and the seat range. The change itself, through
// the mock's webhook, needs Postgres: billing/seats.db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { answers, queries, changed } = vi.hoisted(() => ({
	answers: new Map<string, unknown>(),
	queries: [] as { sql: string; params: unknown[] }[],
	changed: [] as unknown[]
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
// The provider's call is recorded, never made: what it does is provider.test.ts's and stripeApi.test.ts's.
vi.mock('./provider.js', async (orig) => {
	const real = await orig<typeof import('./provider.js')>();
	return {
		...real,
		billingProvider: (...args: Parameters<typeof real.billingProvider>) => {
			const p = real.billingProvider(...args);
			return p && { ...p, changeSeats: async (c: unknown) => void changed.push(c) };
		}
	};
});

const { createApp } = await import('../app.js');
const app = createApp();

const U = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const LIVE = { status: 'active', seats: 3, periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', trialEnd: null, cancelAtPeriodEnd: false };
const teamPlan = (subscription: unknown = LIVE, code = 'team') => ({ account: { id: A, kind: 'team' }, plan: { code, name: 'Team', limits: { seats_included: 3 } }, subscription, usage: {} });
const PLANS = [
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
const post = (body: unknown, user: string | null = U, team = T) =>
	app.request(`/teams/${team}/plan/seats`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
		body: JSON.stringify(body)
	});

beforeEach(() => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', 'test-only-billing-secret-0000000000000000');
	answers.set('app_team_billing_account', [{ id: A }]);
	answers.set('app_account_plan', [{ plan: teamPlan() }]);
	answers.set('app_billing_customer_ref', [{ ref: null }]);
	answers.set('app_billing_live_subscription_ref', [{ ref: { provider: 'mock', externalRef: 'sub_mock_x' } }]);
	answers.set('app_billing_plans', PLANS);
});
afterEach(() => {
	answers.clear();
	queries.length = 0;
	changed.length = 0;
	vi.unstubAllEnvs();
});

describe('POST /teams/:id/plan/seats', () => {
	it('is 401 without a session, and 404 for a malformed id or a caller app_account_plan refuses, before any provider call', async () => {
		expect((await post({ seats: 5 }, null)).status).toBe(401);
		expect((await post({ seats: 5 }, U, 'not-a-uuid')).status).toBe(404);
		answers.set('app_account_plan', [{ plan: null }]);
		vi.stubEnv('BILLING_PROVIDER', 'manual');
		expect((await post({ seats: 5 })).status).toBe(404);
		expect(changed).toEqual([]);
	});

	it('asks the provider for the new seats on a live Team subscription (positive control), and writes none itself', async () => {
		const res = await post({ seats: 5 });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ seats: 5 });
		expect(changed).toEqual([
			expect.objectContaining({ accountId: A, externalRef: 'sub_mock_x', seats: 5, plan: expect.objectContaining({ code: 'team', seatsIncluded: 3, extraSeatMonthlyMinor: 49900 }) })
		]);
		expect(queries.some((q) => /UPDATE|INSERT|app_billing_apply/i.test(q.sql))).toBe(false);
	});

	it('is 409 with no subscription, an ended one, or a plan other than Team', async () => {
		for (const plan of [teamPlan(null), teamPlan({ ...LIVE, status: 'canceled' }), teamPlan(LIVE, 'pro')]) {
			answers.set('app_account_plan', [{ plan }]);
			expect((await post({ seats: 5 })).status).toBe(409);
		}
		expect(changed).toEqual([]);
	});

	it('refuses a staff grant with billing_grant_seats, and the manual provider with billing_unavailable', async () => {
		answers.set('app_billing_live_subscription_ref', [{ ref: { provider: 'manual', externalRef: null } }]);
		const grant = await post({ seats: 5 });
		expect(grant.status).toBe(409);
		expect(((await grant.json()) as { code: string }).code).toBe('billing_grant_seats');
		answers.set('app_billing_live_subscription_ref', [{ ref: { provider: 'stripe', externalRef: 'sub_123' } }]);
		vi.stubEnv('BILLING_PROVIDER', 'manual');
		const manual = await post({ seats: 5 });
		expect(manual.status).toBe(409);
		expect(((await manual.json()) as { code: string }).code).toBe('billing_unavailable');
		expect(changed).toEqual([]);
	});

	it('is 409 for a subscription another provider holds', async () => {
		answers.set('app_billing_live_subscription_ref', [{ ref: { provider: 'stripe', externalRef: 'sub_123' } }]);
		expect((await post({ seats: 5 })).status).toBe(409);
		expect(changed).toEqual([]);
	});

	it('takes seats from the included ones to 50, a whole number, not the current count, and no other field', async () => {
		for (const body of [{ seats: 2 }, { seats: 51 }, { seats: 4.5 }, { seats: '5' }, {}, { seats: 3 }, { seats: 5, plan: 'team' }]) {
			expect((await post(body)).status, JSON.stringify(body)).toBe(400);
		}
		expect((await post({ seats: 50 })).status).toBe(200);
		expect(changed).toHaveLength(1);
	});
});
