// A team admin sets a member's share of the team's assistant dollars (339_team_assistant_share, issue #641
// "One person may use at most 50% unless a team admin raises it"; docs/billing.md § Assistant dollar caps):
//   - POST /teams/:id/plan/assistant-share: the team's admin sets it (positive control) and GET …/plan shows it as
//     team.assistantMemberMaxPct (50 by default); a team member and a stranger get 404 and the share is unchanged;
//     a pct outside 1–100, not whole, or a body with any other field is 400;
//   - app_team_set_assistant_share itself: NULL to a non-admin (nothing written), 23514 for a pct outside 1–100;
//   - enforced, a Team member past half the pooled month is refused (`member`) and, once the admin raises the share
//     to 80%, may chat again: the share the route writes is the one app_assistant_begin (336) reads.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let admin: User;
let member: User;
let stranger: User;
let teamId: string;
let projectId: string;
let account: string;

const PRICE = 2.5;
const MIN = 1_000;
const MAX = 150_000;

const share = async () => Number(((await asOwner('SELECT assistant_member_max_pct AS p FROM billing_account WHERE id = $1', [account])) as { p: number }[])[0]!.p);
const post = (u: User, body: unknown) => u.call('POST', `/teams/${teamId}/plan/assistant-share`, body);
const utcMonth = async () => (await asOwner(`SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS m`))[0]!.m as string;
const refusal = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: { code?: string }) => e.code
	);

/** A turn's begin as `u`, with 336's arguments as dollarCaps.db.test.ts passes them (a pool too big to bind). */
async function begin(u: User): Promise<string> {
	return withUser(u.id, async (db) => {
		const { rows } = await db.query<{ outcome: string }>(
			`SELECT outcome FROM app_assistant_begin($1, 1000000000, 1000, 1000000000, 10000000000000, $2, $3, 300, $4, 300000, 20, 1e15::bigint)`,
			[projectId, MAX, MIN, PRICE]
		);
		return rows[0]!.outcome;
	});
}

beforeAll(async () => {
	[admin, member, stranger] = (await Promise.all(['ShAdmin', 'ShMember', 'ShStranger'].map((n) => signUp(n)))) as [User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: `Share WUA ${crypto.randomUUID().slice(0, 8)}` })).body.team.id;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
	projectId = ((await asOwner('INSERT INTO project (name, created_by, team_id) VALUES ($1, $2, $3) RETURNING id', ['Share', admin.id, teamId])) as { id: string }[])[0]!.id;
	account = ((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [projectId])) as { a: string }[])[0]!.a;
	expect(account).toBeTruthy();
}, 120_000);

afterEach(async () => {
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
	await asOwner('DELETE FROM assistant_usage WHERE project_id = $1', [projectId]);
	await asOwner('DELETE FROM assistant_day_usage WHERE billing_account_id = $1', [account]);
	await asOwner('DELETE FROM assistant_rate WHERE user_id = ANY($1)', [[admin.id, member.id]]);
	await asOwner('DELETE FROM subscription WHERE billing_account_id = $1', [account]);
	await asOwner('UPDATE billing_account SET assistant_member_max_pct = 50 WHERE id = $1', [account]);
});

afterAll(async () => {
	await asOwner('DELETE FROM project WHERE id = $1', [projectId]);
});

describe('POST /teams/:id/plan/assistant-share', () => {
	it('the team’s admin sets it, and GET …/plan shows it (50 by default)', async () => {
		const before = await admin.call('GET', `/teams/${teamId}/plan`);
		expect(before.status).toBe(200);
		expect(before.body.team).toMatchObject({ assistantMemberMaxPct: 50 });
		const res = await post(admin, { pct: 80 });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ pct: 80 });
		expect(await share()).toBe(80);
		expect((await admin.call('GET', `/teams/${teamId}/plan`)).body.team).toMatchObject({ assistantMemberMaxPct: 80 });
		// 100 (no per-member limit) and 1 are the bounds.
		expect((await post(admin, { pct: 100 })).status).toBe(200);
		expect((await post(admin, { pct: 1 })).status).toBe(200);
		expect(await share()).toBe(1);
	});

	it('is 404 to a team member and a stranger, and changes nothing (the admin is the positive control above)', async () => {
		for (const u of [member, stranger]) {
			expect((await post(u, { pct: 90 })).status, u.email).toBe(404);
			// A bad body too: access is checked first, so it doesn't say the team exists.
			expect((await post(u, { pct: 0 })).status, u.email).toBe(404);
		}
		expect(await share()).toBe(50);
		expect((await post(admin, { pct: 90 })).status).toBe(200);
		expect(await share()).toBe(90);
	});

	it('refuses a pct outside 1–100, not whole, or with another field (400)', async () => {
		for (const body of [{ pct: 0 }, { pct: 101 }, { pct: 50.5 }, { pct: '60' }, {}, { pct: 60, accountId: account }])
			expect((await post(admin, body)).status, JSON.stringify(body)).toBe(400);
		expect(await share()).toBe(50);
	});

	it('is 404 for a team id that isn’t a uuid', async () => {
		expect((await admin.call('POST', '/teams/not-a-team/plan/assistant-share', { pct: 60 })).status).toBe(404);
	});
});

describe('app_team_set_assistant_share (339)', () => {
	const call = (u: User, pct: number | null) =>
		withUser(u.id, async (db) => (await db.query<{ v: number | null }>('SELECT app_team_set_assistant_share($1, $2) AS v', [teamId, pct])).rows[0]!.v);

	it('answers the admin the share stored (positive control), NULL to a member and a stranger, who write nothing', async () => {
		expect(await call(admin, 70)).toBe(70);
		expect(await call(member, 95)).toBeNull();
		expect(await call(stranger, 95)).toBeNull();
		expect(await share()).toBe(70);
	});

	it('refuses a pct outside 1–100 with 23514, even from the admin', async () => {
		for (const pct of [0, 101, -5, null]) expect(await refusal(call(admin, pct)), String(pct)).toBe('23514');
		expect(await share()).toBe(50);
	});
});

describe('the share binds the member cap (336) when billing is enforced', () => {
	it('a member past half the pooled month is refused; raised to 80% by the admin, they may chat again', async () => {
		vi.stubEnv('BILLING_ENFORCED', 'true');
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'team', 'active', 3, 'manual')`, [account]);
		// $45 pooled (3 seats × $15); the member has used $22.50, half.
		await asOwner('INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros) VALUES ($1, $2, $3, $4)', [projectId, member.id, await utcMonth(), 22_500_000]);
		expect(await begin(member)).toBe('member');
		// Another member of the same team still may (positive control).
		expect(await begin(admin)).toBe('ok');
		expect((await post(admin, { pct: 80 })).status).toBe(200);
		expect(await begin(member)).toBe('ok');
	});
});
