// The billing routes without a database (routes.ts), through the real app:
// the session gate, the 404s, and that each answer is the definer function's
// JSON plus "enforced". Who may read which account needs Postgres:
// billing/routes.db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { answers, queries, users } = vi.hoisted(() => ({
	answers: new Map<string, unknown>(),
	queries: [] as { sql: string; params: unknown[] }[],
	users: [] as (string | null)[]
}));

/** Every query answers from `answers`, keyed by the function it calls. */
const db = {
	query: async (sql: string, params: unknown[] = []) => {
		queries.push({ sql, params });
		const fn = /app_\w+/.exec(sql)?.[0] ?? '';
		return { rows: (answers.get(fn) as unknown[]) ?? [] };
	}
};
vi.mock('../db/tx.js', async (orig) => ({
	...(await orig<typeof import('../db/tx.js')>()),
	withUser: async (u: string, fn: (d: unknown) => unknown) => (users.push(u), fn(db)),
	withoutUser: async (fn: (d: unknown) => unknown) => (users.push(null), fn(db))
}));
vi.mock('../auth/middleware.js', async (orig) => {
	const real = await orig<typeof import('../auth/middleware.js')>();
	return {
		...real,
		// A session is the header here; without one, the real 401.
		requireUser: async (c: Parameters<typeof real.requireUser>[0], next: Parameters<typeof real.requireUser>[1]) => {
			const u = c.req.header('x-test-user');
			if (!u) return c.json({ error: 'unauthorized' }, 401);
			c.set('userId', u);
			return next();
		}
	};
});

const { createApp } = await import('../app.js');
const app = createApp();

const U = '11111111-1111-4111-8111-111111111111';
const T = '33333333-3333-4333-8333-333333333333';
const A = '22222222-2222-4222-8222-222222222222';
const PLAN = {
	account: { id: A, kind: 'user' },
	plan: { code: 'free', name: 'Free', priceMonthlyMinor: 0, priceAnnualMinor: 0, currency: 'ZAR', limits: { catchments: null }, features: {} },
	subscription: null,
	usage: { month: '2026-11', catchments: { used: 1, limit: null }, reports: { used: 2, limit: 5 }, packsIssued: { used: 0, limit: 0 }, assistantTokens: { used: 0, limit: null } }
};
const get = (path: string, user?: string) => app.request(path, { headers: user ? { 'x-test-user': user } : {} });

afterEach(() => {
	answers.clear();
	queries.length = 0;
	users.length = 0;
	vi.unstubAllEnvs();
});

describe('GET /billing/plans', () => {
	it('answers anyone, signed out included, with the active plans in the public shape', async () => {
		answers.set('app_billing_plans', [
			{ p: { code: 'pro', name: 'Pro', price_monthly_minor: 89900, price_annual_minor: 899000, currency: 'ZAR', limits: {}, features: {}, trial_days: 14, active: true } },
			{ p: { code: 'free', name: 'Free', price_monthly_minor: 0, price_annual_minor: 0, currency: 'ZAR', limits: {}, features: {}, trial_days: null, active: true } }
		]);
		const res = await get('/billing/plans');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plans: { code: string }[] };
		expect(body.plans.map((p: { code: string }) => p.code)).toEqual(['free', 'pro']);
		expect(body.plans[1]).toEqual({ code: 'pro', name: 'Pro', priceMonthlyMinor: 89900, priceAnnualMinor: 899000, currency: 'ZAR', limits: {}, features: {}, trialDays: 14 });
		expect(users).toEqual([null]);
	});
});

describe('GET /account/plan', () => {
	it('is 401 without a session, before any query', async () => {
		expect((await get('/account/plan')).status).toBe(401);
		expect(queries).toEqual([]);
	});

	it('is the caller’s own account’s plan, as the caller, with enforced false by default', async () => {
		answers.set('app_my_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: PLAN }]);
		const res = await get('/account/plan', U);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({ ...PLAN, enforced: false });
		expect(users).toEqual([U]);
		expect(queries.find((q) => q.sql.includes('app_account_plan'))!.params).toEqual([A]);
	});

	it('reports BILLING_ENFORCED=true', async () => {
		vi.stubEnv('BILLING_ENFORCED', 'true');
		answers.set('app_my_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: PLAN }]);
		expect(((await (await get('/account/plan', U)).json()) as { enforced: boolean }).enforced).toBe(true);
	});

	it('is a plain 500, no DB text, if the function gives the caller no plan of their own', async () => {
		answers.set('app_my_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: null }]);
		const res = await get('/account/plan', U);
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain('app_account_plan');
	});
});

describe('GET /teams/:id/plan', () => {
	it('is 401 without a session', async () => {
		expect((await get(`/teams/${T}/plan`)).status).toBe(401);
	});

	it('is 404 for an id that is not a UUID, before any query', async () => {
		expect((await get('/teams/not-a-team/plan', U)).status).toBe(404);
		expect(queries).toEqual([]);
	});

	it('is 404 unless the caller is a team admin (app_team_billing_account answers null)', async () => {
		answers.set('app_team_billing_account', [{ id: null }]);
		answers.set('app_account_plan', [{ plan: PLAN }]);
		expect((await get(`/teams/${T}/plan`, U)).status).toBe(404);
		expect(queries.some((q) => q.sql.includes('app_account_plan'))).toBe(false);
	});

	it('is 404 when app_account_plan refuses the account', async () => {
		answers.set('app_team_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: null }]);
		expect((await get(`/teams/${T}/plan`, U)).status).toBe(404);
	});

	it('is the team account’s plan for an admin (positive control)', async () => {
		const team = { ...PLAN, account: { id: A, kind: 'team' } };
		answers.set('app_team_billing_account', [{ id: A }]);
		answers.set('app_account_plan', [{ plan: team }]);
		const res = await get(`/teams/${T}/plan`, U);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ...team, enforced: false });
		expect(queries.find((q) => q.sql.includes('app_team_billing_account'))!.params).toEqual([T]);
		expect(users).toEqual([U]);
	});
});
