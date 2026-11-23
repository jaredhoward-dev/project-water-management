// Billing's schema in shadow mode (323_billing.sql, issue #641 Phase 1):
//  - a person reads their own account, its subscriptions and counters, and a team admin the team's
//    (positive controls); a team member, a project editor and an outsider read none of them;
//  - app_entitlements gives editors and owners the plan; viewers, farmers and outsiders get NULL;
//  - a new project bills to its team's account, else its creator's, and moving it into a team moves it;
//    water_app can't write project.billing_account_id itself;
//  - the backfill on synthetic rows: team projects to the team, the rest to the creator, a creator-less one to none;
//  - app_usage_add counts per SAST month (the month's edge under skewed session time zones), any role may count,
//    an outsider may not, and nothing ever refuses for a limit;
//  - at most one live subscription per account; a live one sets the plan;
//  - deleting an account takes its billing account and leaves its projects, unbilled.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let outsider: User;
let teamAdmin: User;
let teamMember: User;
let projectId: string;
let teamId: string;
let teamProjectId: string;

const accountOfUser = async (userId: string) =>
	((await asOwner('SELECT id FROM billing_account WHERE user_id = $1', [userId])) as { id: string }[])[0]?.id;
const accountOfTeam = async (team: string) =>
	((await asOwner('SELECT id FROM billing_account WHERE team_id = $1', [team])) as { id: string }[])[0]?.id;
const projectAccount = async (pid: string) =>
	((await asOwner('SELECT billing_account_id FROM project WHERE id = $1', [pid])) as { billing_account_id: string | null }[])[0]!
		.billing_account_id;
const one = async <T>(u: User, sql: string, params: unknown[] = []): Promise<T> =>
	withUser(u.id, async (db) => (await db.query(sql, params)).rows[0]!.v as T);
const sqlState = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return (e as { code?: string }).code;
	}
};

beforeAll(async () => {
	[owner, editor, viewer, farmer, outsider, teamAdmin, teamMember] = (await Promise.all(
		['BillOwner', 'BillEditor', 'BillViewer', 'BillFarmer', 'BillOutsider', 'BillTeamAdmin', 'BillTeamMember'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Billing personal' })).body.project.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	// A farmer's role, set directly: only the role matters to the plan functions.
	await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer')`, [projectId, farmer.id]);
	teamId = (await teamAdmin.call('POST', '/teams', { name: 'Billing WUA' })).body.team.id;
	await teamAdmin.call('POST', `/teams/${teamId}/members`, { email: teamMember.email, role: 'member' });
	teamProjectId = (await teamAdmin.call('POST', '/projects', { name: 'Billing team catchment', teamId })).body.project.id;
});

afterAll(async () => {
	await asOwner('DELETE FROM subscription WHERE billing_account_id IN (SELECT billing_account_id FROM project WHERE id = ANY($1))', [
		[projectId, teamProjectId]
	]);
});

describe('plans', () => {
	it('lists the three active plans to anyone, with a closed limits key set', async () => {
		const plans = await withUser(outsider.id, async (db) => (await db.query('SELECT code, limits FROM app_billing_plans()')).rows);
		expect(plans.map((p) => p.code)).toEqual(['free', 'pro', 'team']);
		expect(plans[0].limits).toMatchObject({ catchments: null, reports_per_month: 5, live_catchments: 1 });
		// The CHECK refuses an unknown key, a missing one and a negative value.
		for (const bad of [
			`limits || '{"scenarios_per_project": 3}'`,
			`limits - 'catchments'`,
			`jsonb_set(limits, '{catchments}', '-1')`,
			`jsonb_set(limits, '{catchments}', '"15"')`
		])
			expect(await sqlState(asOwner(`UPDATE plan SET limits = ${bad} WHERE code = 'pro'`))).toBe('23514');
	});
});

describe('who reads an account', () => {
	it('a new personal project bills to its creator, a team project to its team', async () => {
		const mine = await accountOfUser(owner.id);
		expect(mine).toBeTruthy();
		expect(await projectAccount(projectId)).toBe(mine);
		const team = await accountOfTeam(teamId);
		expect(team).toBeTruthy();
		expect(await projectAccount(teamProjectId)).toBe(team);
		expect(await accountOfUser(teamAdmin.id)).toBeUndefined(); // their only project is the team's
	});

	it('the person reads their own account and plan (positive control); an editor, a team admin and an outsider do not', async () => {
		const mine = await one<string>(owner, 'SELECT app_my_billing_account() AS v');
		expect(mine).toBe(await accountOfUser(owner.id));
		const plan = await one<Record<string, any>>(owner, 'SELECT app_account_plan($1) AS v', [mine]);
		expect(plan).toMatchObject({
			account: { id: mine, kind: 'user' },
			plan: { code: 'free', name: 'Free', priceMonthlyMinor: 0, currency: 'ZAR' },
			subscription: null,
			usage: { catchments: { used: 1, limit: null }, reports: { limit: 5 }, packsIssued: { limit: 0 }, assistantTokens: { used: 0, limit: null } }
		});
		expect(plan.usage.month).toMatch(/^\d{4}-\d{2}$/);
		expect(await one(owner, 'SELECT count(*)::int AS v FROM billing_account WHERE id = $1', [mine])).toBe(1);
		for (const u of [editor, viewer, farmer, outsider, teamAdmin]) {
			expect(await one(u, 'SELECT app_account_plan($1) AS v', [mine]), u.email).toBeNull();
			expect(await one(u, 'SELECT count(*)::int AS v FROM billing_account WHERE id = $1', [mine]), u.email).toBe(0);
		}
	});

	it("a team admin reads the team's account (positive control); a team member does not", async () => {
		const team = await one<string>(teamAdmin, 'SELECT app_team_billing_account($1) AS v', [teamId]);
		expect(team).toBe(await accountOfTeam(teamId));
		expect(await one(teamAdmin, 'SELECT app_account_plan($1) AS v', [team])).toMatchObject({
			account: { kind: 'team' },
			usage: { catchments: { used: 1 } }
		});
		expect(await one(teamMember, 'SELECT app_team_billing_account($1) AS v', [teamId])).toBeNull();
		expect(await one(teamMember, 'SELECT app_account_plan($1) AS v', [team])).toBeNull();
		expect(await one(teamMember, 'SELECT count(*)::int AS v FROM billing_account WHERE id = $1', [team])).toBe(0);
		expect(await one(outsider, 'SELECT app_team_billing_account($1) AS v', [teamId])).toBeNull();
	});

	it('water_app writes no billing table and cannot move a project to another account', async () => {
		const team = await accountOfTeam(teamId);
		expect(await sqlState(withUser(owner.id, (db) => db.query('UPDATE project SET billing_account_id = $1 WHERE id = $2', [team, projectId])))).toBe(
			'42501'
		);
		expect(await sqlState(withUser(owner.id, (db) => db.query(`INSERT INTO billing_account (kind, user_id) VALUES ('user', $1)`, [editor.id])))).toBe(
			'42501'
		);
		expect(await sqlState(withUser(owner.id, (db) => db.query('UPDATE usage_counter SET qty = 0')))).toBe('42501');
		expect(await projectAccount(projectId)).toBe(await accountOfUser(owner.id));
	});
});

describe('entitlements', () => {
	it('editors and owners get the plan; viewers, farmers and outsiders get NULL', async () => {
		for (const u of [owner, editor])
			expect(await one(u, 'SELECT app_entitlements($1) AS v', [projectId]), u.email).toMatchObject({ plan: 'free', status: null, limits: { catchments: null } });
		for (const u of [viewer, farmer, outsider]) expect(await one(u, 'SELECT app_entitlements($1) AS v', [projectId]), u.email).toBeNull();
		expect(await one(teamMember, 'SELECT app_entitlements($1) AS v', [teamProjectId])).toMatchObject({ plan: 'free' });
	});
});

describe('subscriptions', () => {
	it('allows one live subscription per account, which sets the plan; the account reads it, an editor does not', async () => {
		const account = (await accountOfUser(owner.id))!;
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'canceled', 'manual')`, [account]);
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, provider, period_start, period_end) VALUES ($1, 'pro', 'active', 'manual', now(), now() + interval '1 month')`,
			[account]
		);
		for (const status of ['active', 'trialing', 'past_due'])
			expect(
				await sqlState(asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'team', $2, 'manual')`, [account, status])),
				status
			).toBe('23505');
		expect(await one(editor, 'SELECT app_entitlements($1) AS v', [projectId])).toMatchObject({ plan: 'pro', status: 'active', limits: { catchments: 15 } });
		expect(await one(owner, 'SELECT app_account_plan($1) AS v', [account])).toMatchObject({
			plan: { code: 'pro', priceMonthlyMinor: 89900 },
			subscription: { status: 'active', seats: 1, cancelAtPeriodEnd: false }
		});
		expect(await one(owner, 'SELECT count(*)::int AS v FROM subscription WHERE billing_account_id = $1', [account])).toBe(2);
		expect(await one(editor, 'SELECT count(*)::int AS v FROM subscription WHERE billing_account_id = $1', [account])).toBe(0);
		await asOwner('DELETE FROM subscription WHERE billing_account_id = $1', [account]);
	});
});

describe('usage', () => {
	it('puts the month edge in South Africa, whatever the session time zone (rule 7)', async () => {
		const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
		await client.connect();
		try {
			for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
				await client.query(`SET TIME ZONE '${tz}'`);
				const { rows } = await client.query(
					`SELECT app_billing_month('2026-10-31T21:59:59Z')::text AS before, app_billing_month('2026-10-31T22:00:00Z')::text AS after`
				);
				expect(rows[0], tz).toEqual({ before: '2026-10-01', after: '2026-11-01' });
			}
		} finally {
			await client.end();
		}
	});

	it("counts to the project's account this SAST month for any role, never refusing; an outsider may not count", async () => {
		const account = (await accountOfUser(owner.id))!;
		const reports = async () =>
			Number(
				(
					(await asOwner(
						`SELECT coalesce(sum(qty), 0) AS q FROM usage_counter WHERE billing_account_id = $1 AND kind = 'reports'
						   AND month = date_trunc('month', now() AT TIME ZONE 'Africa/Johannesburg')::date`,
						[account]
					)) as { q: string }[]
				)[0]!.q
			);
		const before = await reports();
		for (const u of [owner, viewer, farmer]) await withUser(u.id, (db) => db.query(`SELECT app_usage_add($1, 'reports')`, [projectId]));
		// Past Free's 5 a month: still counted, never refused (shadow mode).
		await withUser(owner.id, async (db) => {
			await db.query(`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
			await db.query(`SELECT app_usage_add($1, 'reports', 10)`, [projectId]);
		});
		expect(await reports()).toBe(before + 13);
		expect(await one(owner, 'SELECT app_account_plan($1) AS v', [account])).toMatchObject({ usage: { reports: { used: before + 13, limit: 5 } } });
		await withUser(teamMember.id, (db) => db.query(`SELECT app_usage_add($1, 'packs_issued')`, [teamProjectId]));
		expect(await one(teamAdmin, 'SELECT app_account_plan($1) AS v', [await accountOfTeam(teamId)])).toMatchObject({ usage: { packsIssued: { used: 1, limit: 0 } } });
		expect(await sqlState(withUser(outsider.id, (db) => db.query(`SELECT app_usage_add($1, 'reports')`, [projectId])))).toBe('42501');
		expect(await sqlState(withUser(owner.id, (db) => db.query(`SELECT app_usage_add($1, 'runs')`, [projectId])))).toBe('22023');
		expect(await sqlState(withUser(owner.id, (db) => db.query(`SELECT app_usage_add($1, 'reports', 0)`, [projectId])))).toBe('22023');
		expect(await reports()).toBe(before + 13);
	});
});

describe('moves, backfill and deletion', () => {
	it('moving a project into a team bills it to the team and counts it there', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Billing moved' })).body.project.id;
		const team = (await accountOfTeam(teamId))!;
		const count = async () => ((await asOwner('SELECT projects_created FROM billing_account WHERE id = $1', [team])) as { projects_created: number }[])[0]!.projects_created;
		const before = await count();
		await asOwner('UPDATE project SET team_id = $1 WHERE id = $2', [teamId, pid]);
		expect(await projectAccount(pid)).toBe(team);
		expect(await count()).toBe(before + 1);
		await asOwner('UPDATE project SET team_id = NULL WHERE id = $1', [pid]);
		expect(await projectAccount(pid)).toBe(await accountOfUser(owner.id));
		await asOwner('DELETE FROM project WHERE id = $1', [pid]);
	});

	it('backfills synthetic projects: team ones to the team, others to their creator, a creator-less one to none', async () => {
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			// Before 323: projects with no account. Clearing the accounts sets the key NULL (ON DELETE SET NULL).
			const orphan = (
				await client.query(`INSERT INTO project (name, created_by) VALUES ('Billing orphan', $1) RETURNING id`, [owner.id])
			).rows[0].id;
			await client.query('DELETE FROM billing_account WHERE user_id = $1 OR team_id = $2', [owner.id, teamId]);
			await client.query(`ALTER TABLE project DISABLE TRIGGER project_maker_kept`);
			await client.query('UPDATE project SET created_by = NULL WHERE id = $1', [orphan]);
			await client.query(`ALTER TABLE project ENABLE TRIGGER project_maker_kept`);
			const nulls = await client.query('SELECT count(*)::int AS n FROM project WHERE id = ANY($1) AND billing_account_id IS NULL', [
				[projectId, teamProjectId, orphan]
			]);
			expect(nulls.rows[0].n).toBe(3);
			await client.query('SELECT billing_backfill()');
			await client.query('SELECT billing_backfill()'); // idempotent
			const rows = (
				await client.query(
					`SELECT p.id, a.kind, a.user_id, a.team_id, a.projects_created FROM project p LEFT JOIN billing_account a ON a.id = p.billing_account_id WHERE p.id = ANY($1)`,
					[[projectId, teamProjectId, orphan]]
				)
			).rows;
			const by = Object.fromEntries(rows.map((r) => [r.id, r]));
			expect(by[projectId]).toMatchObject({ kind: 'user', user_id: owner.id, team_id: null });
			expect(by[teamProjectId]).toMatchObject({ kind: 'team', team_id: teamId, user_id: null, projects_created: 1 });
			expect(by[orphan]).toMatchObject({ kind: null });
			// The owner's account counts every project it bills (their other files' projects included), at least this one.
			expect(by[projectId].projects_created).toBeGreaterThanOrEqual(1);
		} finally {
			await client.query('ROLLBACK');
			await client.end();
		}
		expect(await projectAccount(projectId)).toBe(await accountOfUser(owner.id));
	});

	it('deleting an account takes its billing account, counters and subscriptions, and keeps its projects unbilled', async () => {
		const gone = await signUp('BillGone');
		const pid = (await gone.call('POST', '/projects', { name: 'Billing gone' })).body.project.id;
		// A project keeps an owner, so the account can go only once someone else owns it too.
		expect((await gone.call('POST', `/projects/${pid}/members`, { email: owner.email, role: 'owner' })).status).toBe(201);
		const account = (await accountOfUser(gone.id))!;
		await withUser(gone.id, (db) => db.query(`SELECT app_usage_add($1, 'reports')`, [pid]));
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'manual')`, [account]);
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		expect(await asOwner('SELECT 1 FROM billing_account WHERE id = $1', [account])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM usage_counter WHERE billing_account_id = $1', [account])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM subscription WHERE billing_account_id = $1', [account])).toEqual([]);
		// The co-owner's account doesn't take it over: Phase 1 leaves it unbilled (a billing-owner transfer is later work).
		expect(await asOwner('SELECT billing_account_id FROM project WHERE id = $1', [pid])).toEqual([{ billing_account_id: null }]);
		await asOwner('DELETE FROM project WHERE id = $1', [pid]);
	});

	it("deleting a team takes the team's account; its projects then bill to their creators", async () => {
		const admin = await signUp('BillTeamGone');
		const team = (await admin.call('POST', '/teams', { name: 'Billing gone WUA' })).body.team.id;
		const pid = (await admin.call('POST', '/projects', { name: 'Billing gone team catchment', teamId: team })).body.project.id;
		const account = (await accountOfTeam(team))!;
		expect(await projectAccount(pid)).toBe(account);
		await asOwner('DELETE FROM team WHERE id = $1', [team]);
		expect(await asOwner('SELECT 1 FROM billing_account WHERE id = $1', [account])).toEqual([]);
		expect(await projectAccount(pid)).toBe(await accountOfUser(admin.id));
		await asOwner('DELETE FROM project WHERE id = $1', [pid]);
	});
});
