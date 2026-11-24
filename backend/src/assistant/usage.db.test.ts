// The dollar caps' 429 names the refusing plan in `params.plan` (usage.ts beginTurn; issue #641's copy): the panel
// offers Compare plans on Free's day and month only, never on the Free pool or a paid account's caps.
//   - the day (Free only) and a Free month carry `plan: 'free'`; a Pro month carries `plan: 'pro'`;
//   - a member's share and the pool carry none;
//   - the month's plan is read as the caller: an editor who may not read the owner's account gets none.
// Every boundary is UTC and worked out by Postgres (CLAUDE.md rule 7: the workspace runs under a skewed TZ).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let editor: User;
let projectId: string;
let account: string;

const DAY_MSGS = 20;

// The Free day is the SAST day (337, assistant_day_of), not the UTC one: from 22:00 to 24:00 UTC they differ.
const sastDay = async () => (await asOwner(`SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS d`))[0]!.d as string;
const utcMonth = async () => (await asOwner(`SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS m`))[0]!.m as string;
const spend = async (u: User, usd: number) =>
	asOwner(
		`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (project_id, month, user_id) DO UPDATE SET cost_usd_micros = assistant_usage.cost_usd_micros + EXCLUDED.cost_usd_micros`,
		[projectId, u.id, await utcMonth(), usd]
	);
const clear = async () => {
	const users = [owner, editor].map((u) => u.id);
	await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
	await asOwner('DELETE FROM assistant_usage WHERE project_id = $1', [projectId]);
	await asOwner('DELETE FROM assistant_day_usage WHERE user_id = ANY($1)', [users]);
	await asOwner('DELETE FROM assistant_rate WHERE user_id = ANY($1)', [users]);
	await asOwner('DELETE FROM subscription WHERE billing_account_id = $1', [account]);
};

beforeAll(async () => {
	[owner, editor] = (await Promise.all(['Planowner', 'Planeditor'].map((n) => signUp(n)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Plan on the cap' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBeLessThan(300);
	account = (await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [projectId]))[0]!.a as string;
	expect(account).toBeTruthy();
});
beforeEach(async () => {
	await clear();
	vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
	vi.stubEnv('BILLING_ENFORCED', 'true');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(clear);

async function post(u: User): Promise<{ status: number; code?: string; params?: Record<string, unknown> }> {
	const res = await app.request(`/projects/${projectId}/assistant/messages`, {
		method: 'POST',
		headers: { cookie: u.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
		body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
	});
	if (res.status !== 429) return { status: res.status };
	const body = (await res.json()) as { code: string; params: Record<string, unknown> };
	return { status: 429, code: body.code, params: body.params };
}

describe('params.plan on the dollar caps’ 429', () => {
	it('a fresh Free person’s turn streams (positive control)', async () => {
		expect((await post(owner)).status).toBe(200);
	});

	it('the Free day: plan free', async () => {
		await asOwner(
			`INSERT INTO assistant_day_usage (billing_account_id, user_id, day, messages, cost_usd_micros) VALUES ($1, $2, $3, $4, 0)`,
			[account, owner.id, await sastDay(), DAY_MSGS]
		);
		vi.stubEnv('ASSISTANT_FREE_MESSAGES_PER_DAY', String(DAY_MSGS));
		const r = await post(owner);
		expect(r).toMatchObject({ status: 429, code: 'assistant_daily_cap' });
		expect(r.params?.plan).toBe('free');
	});

	it('a Free month: plan free for the owner; none for an editor who can’t read the owner’s account', async () => {
		await spend(owner, 1_000_001);
		const mine = await post(owner);
		expect(mine).toMatchObject({ status: 429, code: 'assistant_monthly_cap' });
		expect(mine.params?.plan).toBe('free');
		const theirs = await post(editor);
		expect(theirs).toMatchObject({ status: 429, code: 'assistant_monthly_cap' });
		expect(theirs.params).not.toHaveProperty('plan');
	});

	it('a Pro month: plan pro (the panel doesn’t upsell)', async () => {
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'pro', 'active', 1, 'manual')`, [account]);
		await spend(owner, 15_000_001);
		const r = await post(owner);
		expect(r).toMatchObject({ status: 429, code: 'assistant_monthly_cap' });
		expect(r.params?.plan).toBe('pro');
	});

	it('a Team member’s share: no plan', async () => {
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'team', 'active', 3, 'manual')`, [account]);
		await spend(owner, 22_500_001);
		const r = await post(owner);
		expect(r).toMatchObject({ status: 429, code: 'assistant_member_cap' });
		expect(r.params).not.toHaveProperty('plan');
	});
});
