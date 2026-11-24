// 334_team_seats (issue #641 Phase 5): one definition of a team's editor seats in use, and the refusal of an editor
// past a Team plan's paid seats when billing is enforced.
//  - app_team_seats_in_use counts team members and admins and direct editors and owners of the team's projects,
//    each once (viewers, contributors, farmers hold none); app_account_plan's editorCount is the same number; the
//    app role can't call it;
//  - off (BILLING_ENFORCED unset, the default) nothing refuses; on, a change that gives someone a new seat past the
//    paid seats is refused (SQLSTATE 23514, constraint plan_limit; the API answers 402 plan_limit), and the same change
//    passes once a seat is added (positive control);
//  - someone already holding a seat (a member made admin, an editor made owner or added to another of the team's
//    projects) costs none, and viewers and farmers are never refused;
//  - a project moving into a full team brings its editors and is refused; a Free team (no subscription) has no cap;
//  - two parallel grants of the last seat: exactly one wins;
//  - confirming an address whose invite would pass the seats still confirms it, the invite stays pending, and
//    accepting it on the invitations page answers 402 plan_limit.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { markVerified } from '../auth/email-routes.js';
import { withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let admin: User;
let member: User;
let viewer1: User;
let viewer2: User;
let editor: User;
let farmer: User;
let outsider: User;
let teamId: string;
let freeTeamId: string;
let account: string;
let projectA: string;
let projectB: string;
const subRef = `sub_seats_${randomUUID()}`;

/** A transaction as the schema owner with billing enforced (as db/tx.ts sets it from BILLING_ENFORCED=true). */
async function enforced(sql: string, params: unknown[] = [], on = true): Promise<void> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		if (on) await client.query(`SELECT set_config('app.billing_enforced', 'on', true)`);
		await client.query(sql, params);
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		await client.end();
	}
}
const refusal = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: { code?: string; constraint?: string }) => `${e.code}/${e.constraint}`
	);
const inUse = async (team = teamId) => Number(((await asOwner('SELECT app_team_seats_in_use($1) AS n', [team])) as { n: string }[])[0]!.n);
const setSeats = (seats: number) =>
	withoutUser(async (db) =>
		db.query('SELECT app_billing_apply($1, $2, $3, $4::jsonb)', [
			'mock',
			`evt_${randomUUID()}`,
			'subscription.updated',
			JSON.stringify({
				accountId: account,
				planCode: 'team',
				status: 'active',
				seats,
				periodStart: '2026-11-01T00:00:00Z',
				periodEnd: '2026-12-01T00:00:00Z',
				trialEnd: null,
				cancelAtPeriodEnd: false,
				externalRef: subRef
			})
		])
	);
const teamRole = (u: User, role: string, team = teamId) =>
	asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, $3::team_role)
		ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [team, u.id, role]);
const projectRole = (project: string, u: User, role: string) =>
	asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3::project_role)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [project, u.id, role]);

beforeAll(async () => {
	[admin, member, viewer1, viewer2, editor, farmer, outsider] = (await Promise.all(
		['SeatAdmin', 'SeatMember', 'SeatViewer1', 'SeatViewer2', 'SeatEditor', 'SeatFarmer', 'SeatOutsider'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: 'Seats WUA' })).body.team.id;
	freeTeamId = (await outsider.call('POST', '/teams', { name: 'Seats free WUA' })).body.team.id;
	const mk = async (name: string) =>
		((await asOwner('INSERT INTO project (name, created_by, team_id) VALUES ($1, $2, $3) RETURNING id', [name, admin.id, teamId])) as { id: string }[])[0]!.id;
	[projectA, projectB] = [await mk('Seats A'), await mk('Seats B')];
	await teamRole(member, 'member');
	await teamRole(viewer1, 'viewer');
	await teamRole(viewer2, 'viewer');
	await projectRole(projectA, editor, 'editor');
	await projectRole(projectA, farmer, 'farmer');
	account = await withUser(admin.id, async (db) => (await db.query<{ v: string }>('SELECT app_team_billing_account($1) AS v', [teamId])).rows[0]!.v);
	// A Team subscription with its 3 included seats: admin, member and editor fill them.
	await setSeats(3);
});

afterEach(() => {
	delete process.env.BILLING_ENFORCED;
});

afterAll(async () => {
	await asOwner('DELETE FROM subscription WHERE billing_account_id = $1', [account]);
	await asOwner('DELETE FROM billing_event WHERE account_id = $1', [account]);
});

describe('app_team_seats_in_use (334)', () => {
	it('counts team members, admins and direct editors once, not viewers or farmers, and is app_account_plan’s editorCount', async () => {
		expect(await inUse()).toBe(3);
		const plan = await withUser(admin.id, async (db) => (await db.query<{ v: { team: unknown } }>('SELECT app_account_plan($1) AS v', [account])).rows[0]!.v);
		expect(plan.team).toEqual({ editorCount: 3 });
	});

	it('the app role can’t call it, nor the guard', async () => {
		for (const sql of ['SELECT app_team_seats_in_use($1)', 'SELECT app_team_seat_guard($1)'])
			expect(await refusal(withUser(admin.id, (db) => db.query(sql, [teamId])))).toBe('42501/undefined');
	});
});

describe('the seat guard (334)', () => {
	it('off by default: a fourth editor on a full team is not refused', async () => {
		await enforced(`UPDATE team_member SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [teamId, viewer1.id], false);
		expect(await inUse()).toBe(4);
		await teamRole(viewer1, 'viewer');
		expect(await inUse()).toBe(3);
	});

	it('on: a new team member or project editor past the paid seats is refused; viewers and farmers are not', async () => {
		expect(await refusal(enforced(`UPDATE team_member SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [teamId, viewer1.id]))).toBe(
			'23514/plan_limit'
		);
		expect(await refusal(enforced(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, outsider.id]))).toBe(
			'23514/plan_limit'
		);
		expect(await refusal(enforced(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'editor')`, [projectB, viewer2.id]))).toBe(
			'23514/plan_limit'
		);
		// No seat: a project viewer, a farmer, a contributor.
		await enforced(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'viewer')`, [projectB, viewer2.id]);
		await enforced(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer')`, [projectB, farmer.id]);
		await enforced(`UPDATE project_member SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [projectB, viewer2.id]);
		expect(await inUse()).toBe(3);
	});

	it('someone already holding a seat costs none, even on a full team', async () => {
		await enforced(`UPDATE team_member SET role = 'admin' WHERE team_id = $1 AND user_id = $2`, [teamId, member.id]);
		await enforced(`UPDATE project_member SET role = 'owner' WHERE project_id = $1 AND user_id = $2`, [projectA, editor.id]);
		await enforced(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'editor')`, [projectB, editor.id]);
		await enforced(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [projectB, member.id]);
		expect(await inUse()).toBe(3);
		await asOwner(`DELETE FROM project_member WHERE project_id = $1 AND user_id = ANY($2)`, [projectB, [editor.id, member.id]]);
		await teamRole(member, 'member');
	});

	it('the API answers 402 plan_limit with the numbers, and passes once a seat is added (positive control)', async () => {
		process.env.BILLING_ENFORCED = 'true';
		const r = await admin.call('PATCH', `/teams/${teamId}/members/${viewer1.id}`, { role: 'member' });
		expect(r.status).toBe(402);
		expect(r.body).toMatchObject({ code: 'plan_limit', params: { limit: 3, used: 4, plan: 'team' } });
		expect(JSON.stringify(r.body)).not.toMatch(/team_member|app_team|DETAIL/);
		await setSeats(4);
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${viewer1.id}`, { role: 'member' })).status).toBe(200);
		expect(await inUse()).toBe(4);
		await teamRole(viewer1, 'viewer');
		await setSeats(3);
	});

	it('a project moving into a full team brings its editors and is refused', async () => {
		const own = ((await asOwner('INSERT INTO project (name, created_by) VALUES ($1, $2) RETURNING id', ['Seats moving', outsider.id])) as { id: string }[])[0]!.id;
		await projectRole(own, outsider, 'owner');
		expect(await refusal(enforced('UPDATE project SET team_id = $1 WHERE id = $2', [teamId, own]))).toBe('23514/plan_limit');
		await setSeats(4);
		await enforced('UPDATE project SET team_id = $1 WHERE id = $2', [teamId, own]);
		expect(await inUse()).toBe(4);
		await asOwner('DELETE FROM project WHERE id = $1', [own]);
		await setSeats(3);
	});

	it('a Free team (no subscription) has no seat cap here', async () => {
		for (const u of [member, viewer1, viewer2, editor]) await enforced(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'member')`, [freeTeamId, u.id]);
		expect(await inUse(freeTeamId)).toBe(5);
	});

	it('confirming an address never fails on a full team: its invite stays pending, and accepting it answers 402', async () => {
		const invited = await signUp('SeatInvited', { verified: false });
		const inviteId = (
			(await asOwner(
				`INSERT INTO invite (email, team_id, team_role, invited_by, token_hash, expires_at)
				 VALUES ($1, $2, 'member', $3, decode($4, 'hex'), now() + interval '7 days') RETURNING id`,
				[invited.email, teamId, admin.id, randomUUID().replaceAll('-', '').repeat(2)]
			)) as { id: string }[]
		)[0]!.id;
		process.env.BILLING_ENFORCED = 'true';
		// As the verify route does: the consumed token proves who, then markVerified runs as them (actAsUser).
		await withUser(invited.id, (db) => markVerified(db, invited.id));
		const [row] = (await asOwner(
			`SELECT u.email_verified_at IS NOT NULL AS verified,
				EXISTS (SELECT 1 FROM team_member WHERE team_id = $2 AND user_id = u.id) AS joined,
				EXISTS (SELECT 1 FROM invite WHERE id = $3) AS pending
			 FROM app_user u WHERE u.id = $1`,
			[invited.id, teamId, inviteId]
		)) as { verified: boolean; joined: boolean; pending: boolean }[];
		expect(row).toEqual({ verified: true, joined: false, pending: true });
		const r = await invited.call('POST', `/me/invites/${inviteId}/accept`);
		expect(r.status).toBe(402);
		expect(r.body).toMatchObject({ code: 'plan_limit' });
		await asOwner('DELETE FROM invite WHERE id = $1', [inviteId]);
	});

	it('two parallel grants of the last seat: exactly one wins', async () => {
		await setSeats(4);
		expect(await inUse()).toBe(3);
		// Both transactions open and enforced before either writes, then both write at once.
		const clients = [new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL }), new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL })];
		for (const c of clients) {
			await c.connect();
			await c.query('BEGIN');
			await c.query(`SELECT set_config('app.billing_enforced', 'on', true)`);
		}
		const results = await Promise.allSettled(
			[viewer1, viewer2].map(async (u, i) => {
				const c = clients[i]!;
				try {
					await c.query(`UPDATE team_member SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [teamId, u.id]);
					await c.query('COMMIT');
				} catch (err) {
					await c.query('ROLLBACK').catch(() => {});
					throw err;
				}
			})
		);
		for (const c of clients) await c.end();
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
		expect(failed.reason).toMatchObject({ code: '23514', constraint: 'plan_limit' });
		expect(await inUse()).toBe(4);
		await teamRole(viewer1, 'viewer');
		await teamRole(viewer2, 'viewer');
	});
});
