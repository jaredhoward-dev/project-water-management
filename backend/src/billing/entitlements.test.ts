// The billing helpers without a database (entitlements.ts): the BILLING_ENFORCED
// switch, the public plan shape, what each helper asks of Postgres, and that a
// server report counts once against its account (reports/store.ts). The SQL
// functions themselves, and who may read what, are billing/routes.db.test.ts
// and billing/billing.db.test.ts.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../jobs/queue.js', () => ({ enqueueJob: vi.fn() }));

const { enqueueJob } = await import('../jobs/queue.js');
const { createReport } = await import('../reports/store.js');
const { accountPlan, atLimit, billingEnforced, countUsage, listPlans, myAccountId, projectEntitlements, teamAccountId, toPublicPlan } = await import('./entitlements.js');

const P = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';

/** A Db that answers each query with `answer(sql)` and records it. */
function fakeDb(answer: (sql: string, params: unknown[]) => unknown[] = () => []) {
	const queries: { sql: string; params: unknown[] }[] = [];
	return {
		queries,
		query: async (sql: string, params: unknown[] = []) => (queries.push({ sql, params }), { rows: answer(sql, params) })
	};
}

const LIMITS = { catchments: 15, editors_per_project: 5, reports_per_month: null };

describe('billingEnforced', () => {
	it('is off unless BILLING_ENFORCED is exactly true (Phase 1: shadow mode)', () => {
		expect(billingEnforced({})).toBe(false);
		expect(billingEnforced({ BILLING_ENFORCED: 'false' })).toBe(false);
		expect(billingEnforced({ BILLING_ENFORCED: '' })).toBe(false);
		expect(billingEnforced({ BILLING_ENFORCED: '1' })).toBe(false);
		expect(billingEnforced({ BILLING_ENFORCED: 'TRUE' })).toBe(false);
		expect(billingEnforced({ BILLING_ENFORCED: 'true' })).toBe(true);
	});
});

describe('atLimit', () => {
	it('is reached at the limit, never for an unlimited (null) one', () => {
		expect(atLimit(4, 5)).toBe(false);
		expect(atLimit(5, 5)).toBe(true);
		expect(atLimit(6, 5)).toBe(true);
		expect(atLimit(0, 0)).toBe(true);
		expect(atLimit(1_000_000, null)).toBe(false);
		expect(atLimit(1, undefined)).toBe(false);
	});
});

describe('toPublicPlan', () => {
	const row = {
		code: 'pro',
		name: 'Pro',
		price_monthly_minor: 89900,
		price_annual_minor: 899000,
		currency: 'ZAR',
		limits: LIMITS,
		features: { live: true },
		trial_days: 14,
		active: true
	};
	const expected = { code: 'pro', name: 'Pro', priceMonthlyMinor: 89900, priceAnnualMinor: 899000, currency: 'ZAR', limits: LIMITS, features: { live: true }, trialDays: 14 };

	it('reads a plan row (snake_case columns) into the API shape, and nothing else', () => {
		expect(toPublicPlan({ ...row, internal_note: 'never sent' })).toEqual(expected);
	});

	it('reads a camelCase object the same way', () => {
		const { price_monthly_minor, price_annual_minor, trial_days, ...rest } = row;
		expect(toPublicPlan({ ...rest, priceMonthlyMinor: price_monthly_minor, priceAnnualMinor: price_annual_minor, trialDays: trial_days })).toEqual(expected);
	});

	it('keeps null limits (unlimited) and a missing trial as null', () => {
		expect(toPublicPlan({ ...row, limits: { catchments: null }, trial_days: null })).toMatchObject({ limits: { catchments: null }, trialDays: null });
	});

	it('drops an inactive plan', () => {
		expect(toPublicPlan({ ...row, active: false })).toBeNull();
	});
});

describe('listPlans', () => {
	const plan = (code: string, monthly: number) => ({ code, name: code, price_monthly_minor: monthly, price_annual_minor: monthly * 10, currency: 'ZAR', limits: {}, features: {}, trial_days: null, active: true });

	it('reads app_billing_plans rows, cheapest first', async () => {
		const db = fakeDb(() => [{ p: plan('team', 249900) }, { p: plan('free', 0) }, { p: plan('pro', 89900) }]);
		expect((await listPlans(db as never)).map((p) => p.code)).toEqual(['free', 'pro', 'team']);
		expect(db.queries[0]!.sql).toContain('app_billing_plans()');
	});

	it('reads a single jsonb array the same way, and leaves out an inactive plan', async () => {
		const db = fakeDb(() => [{ p: [plan('pro', 89900), { ...plan('old', 100), active: false }, plan('free', 0)] }]);
		expect((await listPlans(db as never)).map((p) => p.code)).toEqual(['free', 'pro']);
	});
});

describe('countUsage', () => {
	it('adds to the project’s counter through app_usage_add', async () => {
		const db = fakeDb();
		await countUsage(db as never, P, 'reports');
		await countUsage(db as never, P, 'packs_issued', 2);
		expect(db.queries).toEqual([
			{ sql: 'SELECT app_usage_add($1, $2, $3)', params: [P, 'reports', 1] },
			{ sql: 'SELECT app_usage_add($1, $2, $3)', params: [P, 'packs_issued', 2] }
		]);
	});

	it.each([0, -1, 1.5, Number.NaN])('refuses a quantity of %s before asking Postgres', async (qty) => {
		const db = fakeDb();
		await expect(countUsage(db as never, P, 'reports', qty)).rejects.toThrow('positive integer');
		expect(db.queries).toEqual([]);
	});
});

describe('accountPlan', () => {
	const plan = { account: { id: A, kind: 'user' }, plan: { code: 'free' }, subscription: null, usage: { month: '2026-11' } };

	it('passes app_account_plan’s answer through and adds enforced', async () => {
		const db = fakeDb(() => [{ plan }]);
		expect(await accountPlan(db as never, A, {})).toEqual({ ...plan, enforced: false, provider: 'mock' });
		expect(await accountPlan(db as never, A, { BILLING_ENFORCED: 'true' })).toEqual({ ...plan, enforced: true, provider: 'mock' });
		// The provider the page reads to show Upgrade and Manage billing (Phase 3); a name that is none is null.
		expect((await accountPlan(db as never, A, { BILLING_PROVIDER: 'manual' }))?.provider).toBe('manual');
		expect((await accountPlan(db as never, A, { BILLING_PROVIDER: 'stripey' }))?.provider).toBeNull();
		expect(db.queries[0]).toEqual({ sql: 'SELECT app_account_plan($1) AS plan', params: [A] });
	});

	it('is null when the caller may not read the account, or there is none', async () => {
		const db = fakeDb(() => [{ plan: null }]);
		expect(await accountPlan(db as never, A)).toBeNull();
		expect(await accountPlan(db as never, null)).toBeNull();
		expect(db.queries).toHaveLength(1);
	});
});

describe('the account lookups', () => {
	it('ask app_my_billing_account and app_team_billing_account', async () => {
		const db = fakeDb((sql) => [{ id: sql.includes('app_team_billing_account') ? null : A }]);
		expect(await myAccountId(db as never)).toBe(A);
		expect(await teamAccountId(db as never, P)).toBeNull();
		expect(db.queries.map((q) => q.sql)).toEqual(['SELECT app_my_billing_account() AS id', 'SELECT app_team_billing_account($1) AS id']);
		expect(db.queries[1]!.params).toEqual([P]);
	});

	it('projectEntitlements reads app_entitlements, null below editor', async () => {
		const e = { plan: 'free', limits: LIMITS, features: {}, status: null };
		expect(await projectEntitlements(fakeDb(() => [{ e }]) as never, P)).toEqual(e);
		expect(await projectEntitlements(fakeDb(() => [{ e: null }]) as never, P)).toBeNull();
	});
});

describe('a server report counts against its account (reports/store.ts createReport)', () => {
	const report = { projectId: P, runId: A, emailTo: [] };

	it('counts one report in the transaction that queues it', async () => {
		vi.mocked(enqueueJob).mockResolvedValueOnce({ job: { id: 'j1' }, created: true } as never);
		const db = fakeDb();
		expect(await createReport(db as never, report)).toEqual({ jobId: 'j1', created: true });
		const sqls = db.queries.map((q) => q.sql);
		expect(sqls[0]).toContain('INSERT INTO report');
		expect(db.queries[1]).toEqual({ sql: 'SELECT app_usage_add($1, $2, $3)', params: [P, 'reports', 1] });
	});

	it('counts nothing for a deduplicated schedule fire (the report was queued and counted already)', async () => {
		vi.mocked(enqueueJob).mockResolvedValueOnce({ job: { id: 'j1' }, created: false } as never);
		const db = fakeDb();
		expect(await createReport(db as never, { ...report, dedupeKey: 'report_schedule:s:t' })).toEqual({ jobId: 'j1', created: false });
		expect(db.queries).toEqual([]);
	});
});
