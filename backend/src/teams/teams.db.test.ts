import { describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

// A provider whose cancel the test controls: `race.onCancel`, when set, runs in place of the configured
// provider's cancelSubscriptions (the mock's), as a checkout completing at the provider meanwhile would.
const race = vi.hoisted(() => ({ onCancel: null as null | ((req: { accountId: string; subscriptionRefs: string[] }) => Promise<string[]>) }));
vi.mock('../billing/provider.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../billing/provider.js')>();
	return {
		...real,
		billingProvider: (...args: Parameters<typeof real.billingProvider>) => {
			const p = real.billingProvider(...args);
			const hook = race.onCancel;
			return p && hook ? { ...p, cancelSubscriptions: hook } : p;
		}
	};
});

describe('teams', () => {
	it('gives team members access to every team project (admin → owner, member → editor)', async () => {
		const admin = await signUp('TeamAdmin');
		const member = await signUp('TeamMember');
		const outsider = await signUp('Outsider');

		const team = await admin.call('POST', '/teams', { name: 'Catchment Consultants' });
		expect(team.status).toBe(201);
		expect(team.body.team).toMatchObject({ name: 'Catchment Consultants', role: 'admin', memberCount: 1 });
		const teamId = team.body.team.id;
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);

		// Three catchments owned by the team, one personal project.
		const ids: string[] = [];
		for (const name of ['Place A', 'Place B', 'Place C']) {
			const r = await admin.call('POST', '/projects', { name, teamId });
			expect(r.status).toBe(201);
			expect(r.body.project.team).toEqual({ id: teamId, name: 'Catchment Consultants', role: 'admin' });
			ids.push(r.body.project.id);
		}
		await admin.call('POST', '/projects', { name: 'Admin private' });

		// Positive control: the member sees exactly the team's three, as editor.
		const list = (await member.call('GET', '/projects')).body.projects;
		expect(list.map((p: { name: string }) => p.name).sort()).toEqual(['Place A', 'Place B', 'Place C']);
		expect(new Set(list.map((p: { role: string }) => p.role))).toEqual(new Set(['editor']));
		expect((await member.call('PATCH', `/projects/${ids[0]}`, { name: 'Place A (edited)' })).status).toBe(200);
		expect((await member.call('DELETE', `/projects/${ids[0]}`)).status).toBe(403);

		// The outsider sees nothing.
		expect((await outsider.call('GET', '/projects')).body.projects).toHaveLength(0);
		expect((await outsider.call('GET', `/projects/${ids[1]}`)).status).toBe(404);
		expect((await outsider.call('GET', `/teams/${teamId}`)).status).toBe(404);

		// A member can create a project in the team; the outsider cannot.
		expect((await member.call('POST', '/projects', { name: 'Place D', teamId })).status).toBe(201);
		expect((await outsider.call('POST', '/projects', { name: 'Sneaky', teamId })).status).toBe(404);
		expect((await admin.call('GET', `/teams/${teamId}`)).body.team.projectCount).toBe(4);

		// Removing the member revokes access to all team projects at once.
		expect((await admin.call('DELETE', `/teams/${teamId}/members/${member.id}`)).status).toBe(204);
		expect((await member.call('GET', `/projects/${ids[1]}`)).status).toBe(404);
	});

	it('moves a personal project into a team (owner only) and keeps one admin', async () => {
		const a = await signUp('Mover');
		const teamId = (await a.call('POST', '/teams', { name: 'T' })).body.team.id;
		const pid = (await a.call('POST', '/projects', { name: 'Solo' })).body.project.id;
		const moved = await a.call('PATCH', `/projects/${pid}`, { teamId });
		expect(moved.status).toBe(200);
		expect(moved.body.project.team.id).toBe(teamId);
		expect((await a.call('DELETE', `/teams/${teamId}/members/${a.id}`)).status).toBe(409);
		expect((await a.call('PATCH', `/teams/${teamId}/members/${a.id}`, { role: 'member' })).status).toBe(409);
	});

	it('deleting a team keeps its projects with their direct owners', async () => {
		const a = await signUp('Deleter');
		const teamId = (await a.call('POST', '/teams', { name: 'Gone' })).body.team.id;
		const pid = (await a.call('POST', '/projects', { name: 'Survivor', teamId })).body.project.id;
		expect((await a.call('DELETE', `/teams/${teamId}`)).status).toBe(204);
		const p = await a.call('GET', `/projects/${pid}`);
		expect(p.status).toBe(200);
		expect(p.body.project.team).toBeNull();
	});

	it('only team admins manage members', async () => {
		const admin = await signUp('Adm');
		const m = await signUp('Mem');
		const other = await signUp('Oth');
		const teamId = (await admin.call('POST', '/teams', { name: 'Roles' })).body.team.id;
		await admin.call('POST', `/teams/${teamId}/members`, { email: m.email, role: 'member' });
		expect((await m.call('POST', `/teams/${teamId}/members`, { email: other.email, role: 'member' })).status).toBe(403);
		expect((await m.call('PATCH', `/teams/${teamId}`, { name: 'x' })).status).toBe(403);
		expect((await m.call('DELETE', `/teams/${teamId}/members/${m.id}`)).status).toBe(204); // leaving is fine
	});
});

describe('moving projects between teams', () => {
	it('lets a team admin (owner only via the team) move a team project to personal and keep it', async () => {
		const creator = await signUp('Creator');
		const admin = await signUp('OtherAdmin');
		const teamId = (await creator.call('POST', '/teams', { name: 'Shared team' })).body.team.id;
		await creator.call('POST', `/teams/${teamId}/members`, { email: admin.email, role: 'admin' });
		const pid = (await creator.call('POST', '/projects', { name: 'Team catchment', teamId })).body.project.id;
		// admin is owner purely through the team
		expect((await admin.call('GET', `/projects/${pid}`)).body.project.role).toBe('owner');
		const moved = await admin.call('PATCH', `/projects/${pid}`, { teamId: null });
		expect(moved.status).toBe(200);
		expect(moved.body.project.team).toBeNull();
		expect(moved.body.project.role).toBe('owner');
	});

	// Issue #900 (392_team_project_move_admin): taking a project out of a team, or into another, needs admin on the
	// team it leaves. Before, a plain member who created a team project (its direct owner) could take it out, so the
	// team's admins lost it, and keep it after leaving the team.
	it('refuses a plain team member, or an outside direct owner, taking a team project out of the team; an admin may', async () => {
		const admin = await signUp('MoveAdmin');
		const member = await signUp('MoveMember');
		const outside = await signUp('MoveOutside');
		const teamId = (await admin.call('POST', '/teams', { name: 'Keeps its projects' })).body.team.id;
		await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' });
		// The member's own team, where they are admin: moving into it is no way round.
		const otherTeam = (await member.call('POST', '/teams', { name: 'Member’s own' })).body.team.id;
		const pid = (await member.call('POST', '/projects', { name: 'Member made it', teamId })).body.project.id;
		expect((await member.call('GET', `/projects/${pid}`)).body.project.role).toBe('owner');
		expect((await admin.call('POST', `/projects/${pid}/members`, { email: outside.email, role: 'owner' })).status).toBe(201);

		for (const [who, to] of [[member, null], [member, otherTeam], [outside, null]] as const) {
			const r = await who.call('PATCH', `/projects/${pid}`, { teamId: to });
			expect(r.status).toBe(403);
			expect(r.body.code).toBe('team_move_admin');
			// The trigger agrees, even if the route's check were missed.
			await expect(withUser(who.id, (db) => db.query('UPDATE project SET team_id = $2 WHERE id = $1', [pid, to]))).rejects.toThrow(
				/admin of the team/
			);
		}
		expect((await admin.call('GET', `/projects/${pid}`)).body.project.team.id).toBe(teamId);
		// The member still edits it, and leaving the team still takes it (leaveProjects.ts).
		expect((await member.call('PATCH', `/projects/${pid}`, { name: 'Renamed by its maker' })).status).toBe(200);

		// Positive control: a team admin may move it to another team they contribute to, and out.
		await member.call('POST', `/teams/${otherTeam}/members`, { email: admin.email, role: 'member' });
		const moved = await admin.call('PATCH', `/projects/${pid}`, { teamId: otherTeam });
		expect(moved.status).toBe(200);
		expect(moved.body.project.team.id).toBe(otherTeam);
		// Now the member is admin of the team it is in, so they may take it out.
		const out = await member.call('PATCH', `/projects/${pid}`, { teamId: null });
		expect(out.status).toBe(200);
		expect(out.body.project.team).toBeNull();
	});
});

// 008_team_viewer: a read-only team role. Team viewers read every team
// project but write nothing, and can't add projects to the team.
describe('team viewer', () => {
	type User = Awaited<ReturnType<typeof signUp>>;
	const seriesBody = (kind: string, unit: string, values: number[]) => ({ kind, unit, startDate: '2020-01-01', values });

	/** A runnable team catchment (outlet gauge + one farm, A-pan, rain, observed flow) with one run. */
	async function teamProject(admin: User, teamId: string) {
		const created = await admin.call('POST', '/projects', { name: 'Team catchment', teamId });
		expect(created.status).toBe(201);
		const projectId = created.body.project.id as string;
		const outlet = node('Gauge', null);
		const farm = node('Farm', outlet.id);
		const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
		expect((await admin.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		expect((await admin.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
		expect((await admin.call('PUT', `/projects/${projectId}/series`, seriesBody('rain_catchment_mm', 'mm', rain))).status).toBe(200);
		const flow = seriesBody('flow_observed_m3s', 'm3/s', new Array(60).fill(0.2));
		expect((await admin.call('PUT', `/projects/${projectId}/series`, flow)).status).toBe(200);
		const run = await admin.call('POST', `/projects/${projectId}/runs`, { label: 'Baseline' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		return { projectId, model, runId: run.body.run.id as string };
	}

	/** A team with its admin plus one user per entry, added directly with that role. */
	async function teamWith(roles: Record<string, 'viewer' | 'member'>) {
		const admin = await signUp('VAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Readers' })).body.team.id as string;
		const users: Record<string, User> = {};
		for (const [name, role] of Object.entries(roles)) {
			const u = await signUp(name);
			const r = await admin.call('POST', `/teams/${teamId}/members`, { email: u.email, role });
			expect(r.status).toBe(201);
			expect(r.body.invite.role).toBe(role);
			users[name] = u;
		}
		return { admin, teamId, users };
	}

	it('reads every team project but cannot change settings, model, series or runs; a member can', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer', Modeller: 'member' });
		const viewer = users.Clerk!;
		const member = users.Modeller!;
		const { projectId, model, runId } = await teamProject(admin, teamId);

		// Read: the project, model, series, runs and the team itself.
		const list = (await viewer.call('GET', '/projects')).body.projects;
		expect(list).toEqual([expect.objectContaining({ id: projectId, role: 'viewer', team: { id: teamId, name: 'Readers' } })]);
		expect((await viewer.call('GET', `/projects/${projectId}`)).body.project.role).toBe('viewer');
		expect((await viewer.call('GET', `/projects/${projectId}/model`)).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${projectId}/series`)).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${projectId}/runs`)).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}`)).status).toBe(200);
		const team = await viewer.call('GET', `/teams/${teamId}`);
		expect(team.status).toBe(200);
		expect(team.body.team.role).toBe('viewer');
		// Admins first, then members, then viewers.
		expect(team.body.members.map((m: { role: string }) => m.role)).toEqual(['admin', 'member', 'viewer']);

		// Write: every path is refused.
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(120) } })).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { name: 'Renamed' })).status).toBe(403);
		expect((await viewer.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(403);
		expect((await viewer.call('PUT', `/projects/${projectId}/series`, seriesBody('rain_catchment_mm', 'mm', [1, 2, 3]))).status).toBe(403);
		expect((await viewer.call('POST', `/projects/${projectId}/runs`, { label: 'Sneaky' })).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${projectId}/runs/${runId}`, { notes: 'x' })).status).toBe(403);
		expect((await viewer.call('DELETE', `/projects/${projectId}/runs/${runId}`)).status).toBe(403);
		expect((await viewer.call('DELETE', `/projects/${projectId}`)).status).toBe(403);
		// …and none of them changed anything.
		expect((await admin.call('GET', `/projects/${projectId}/runs`)).body.runs).toHaveLength(1);
		expect((await admin.call('GET', `/projects/${projectId}`)).body.project.name).toBe('Team catchment');

		// Positive control: the team member writes the same things.
		expect((await member.call('GET', `/projects/${projectId}`)).body.project.role).toBe('editor');
		expect((await member.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(120) } })).status).toBe(200);
		expect((await member.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const rain = seriesBody('rain_catchment_mm', 'mm', new Array(60).fill(1));
		expect((await member.call('PUT', `/projects/${projectId}/series`, rain)).status).toBe(200);
		const run = await member.call('POST', `/projects/${projectId}/runs`, { label: 'Member run' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
	});

	it('is enforced by RLS, not only by the API (as water_app)', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer', Modeller: 'member' });
		const { projectId } = await teamProject(admin, teamId);
		const asViewer = await withUser(users.Clerk!.id, async (db) => ({
			seen: (await db.query('SELECT id FROM project WHERE id = $1', [projectId])).rowCount,
			series: (await db.query('SELECT id FROM time_series WHERE project_id = $1', [projectId])).rowCount,
			renamed: (await db.query(`UPDATE project SET name = 'x' WHERE id = $1`, [projectId])).rowCount,
			seriesDeleted: (await db.query('DELETE FROM time_series WHERE project_id = $1', [projectId])).rowCount,
			role: (await db.query('SELECT app_project_role($1) AS r', [projectId])).rows[0].r
		}));
		expect(asViewer).toEqual({ seen: 1, series: 2, renamed: 0, seriesDeleted: 0, role: 'viewer' });
		await expect(
			withUser(users.Clerk!.id, (db) =>
				db.query(
					`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
					 VALUES ($1, 'rain_catchment_mm', 'r', 'mm', '2020-01-01', '{1}')`,
					[projectId]
				)
			)
		).rejects.toThrow(/row-level security/);
		// Positive control: a team member passes the same policies.
		const asMember = await withUser(users.Modeller!.id, async (db) => ({
			renamed: (await db.query(`UPDATE project SET name = 'Renamed' WHERE id = $1`, [projectId])).rowCount,
			role: (await db.query('SELECT app_project_role($1) AS r', [projectId])).rows[0].r
		}));
		expect(asMember).toEqual({ renamed: 1, role: 'editor' });
	});

	it("can't create, move or copy a project into the team (a copy is personal); a member can", async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer', Modeller: 'member' });
		const viewer = users.Clerk!;
		expect((await viewer.call('POST', '/projects', { name: 'Mine in team', teamId })).status).toBe(403);
		// RLS agrees, even if the API check were missed.
		await expect(
			withUser(viewer.id, (db) =>
				db.query(`INSERT INTO project (id, name, created_by, team_id) VALUES (gen_random_uuid(), 'x', app_current_user_id(), $1)`, [teamId])
			)
		).rejects.toThrow(/row-level security/);

		const own = (await viewer.call('POST', '/projects', { name: 'Personal' })).body.project.id;
		expect((await viewer.call('PATCH', `/projects/${own}`, { teamId })).status).toBe(403);
		await expect(withUser(viewer.id, (db) => db.query('UPDATE project SET team_id = $2 WHERE id = $1', [own, teamId]))).rejects.toThrow(
			/row-level security/
		);
		expect((await viewer.call('GET', `/projects/${own}`)).body.project.team).toBeNull();

		const { projectId } = await teamProject(admin, teamId);
		const copy = await viewer.call('POST', `/projects/${projectId}/copy`, { name: 'My copy' });
		expect(copy.status).toBe(201);
		expect(copy.body.project).toMatchObject({ team: null, role: 'owner' });

		// Positive control: a team member creates, moves and copies into the team.
		const member = users.Modeller!;
		expect((await member.call('POST', '/projects', { name: 'Member in team', teamId })).status).toBe(201);
		const mine = (await member.call('POST', '/projects', { name: 'Member personal' })).body.project.id;
		expect((await member.call('PATCH', `/projects/${mine}`, { teamId })).body.project.team.id).toBe(teamId);
		expect((await member.call('POST', `/projects/${projectId}/copy`, { name: 'Team copy' })).body.project.team.id).toBe(teamId);
	});

	it('leaves a direct editor who is only a team viewer able to edit (the team is unchanged)', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer' });
		const viewer = users.Clerk!;
		const { projectId } = await teamProject(admin, teamId);
		expect((await admin.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'editor' })).status).toBe(201);
		expect((await viewer.call('GET', `/projects/${projectId}`)).body.project.role).toBe('editor');
		const r = await viewer.call('PATCH', `/projects/${projectId}`, { name: 'Edited by direct editor' });
		expect(r.status).toBe(200);
		expect(r.body.project.name).toBe('Edited by direct editor');

		// The same for a direct editor who isn't in the team at all.
		const outsider = await signUp('DirectOnly');
		expect((await admin.call('POST', `/projects/${projectId}/members`, { email: outsider.email, role: 'editor' })).status).toBe(201);
		const o = await outsider.call('PATCH', `/projects/${projectId}`, { name: 'Edited from outside the team' });
		expect(o.status).toBe(200);
		expect(o.body.project.team).toEqual({ id: teamId, name: null, role: null });
	});

	it('admins change roles to and from viewer; other roles are rejected; the last admin stays', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'member' });
		const u = users.Clerk!;
		const { projectId } = await teamProject(admin, teamId);
		const down = await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role: 'viewer' });
		expect(down.status).toBe(200);
		expect(down.body.member.role).toBe('viewer');
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.role).toBe('viewer');
		expect((await u.call('PATCH', `/projects/${projectId}`, { name: 'x' })).status).toBe(403);
		const up = await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role: 'member' });
		expect(up.body.member.role).toBe('member');
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.role).toBe('editor');

		for (const role of ['owner', 'editor', 'VIEWER', '']) {
			expect((await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role })).status).toBe(400);
			expect((await admin.call('POST', `/teams/${teamId}/members`, { email: 'nobody@example.com', role })).status).toBe(400);
		}
		// The sole admin can't demote themselves to viewer either.
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${admin.id}`, { role: 'viewer' })).status).toBe(409);
		// A viewer manages nothing, but may leave.
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role: 'viewer' })).status).toBe(200);
		expect((await u.call('POST', `/teams/${teamId}/members`, { email: 'x@example.com', role: 'viewer' })).status).toBe(403);
		expect((await u.call('PATCH', `/teams/${teamId}`, { name: 'x' })).status).toBe(403);
		expect((await u.call('GET', `/teams/${teamId}/invites`)).status).toBe(403);
		expect((await u.call('DELETE', `/teams/${teamId}/members/${u.id}`)).status).toBe(204);
		expect((await u.call('GET', `/projects/${projectId}`)).status).toBe(404);
	});
});

describe('DELETE /teams/:id: the team’s paid plan is cancelled at the provider first (docs/billing.md § Deleting an account)', () => {
	const teamWithPlan = async (name: string, provider: string, ref: string) => {
		const admin = await signUp(name);
		const teamId = (await admin.call('POST', '/teams', { name: `${name} ${ref.slice(-6)}` })).body.team.id as string;
		const account = await withUser(admin.id, async (db) => (await db.query<{ id: string }>('SELECT app_team_billing_account($1) AS id', [teamId])).rows[0]!.id);
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, provider, external_ref, period_start, period_end)
			 VALUES ($1, 'team', 'active', $2, $3, now() - interval '1 day', now() + interval '29 days')`,
			[account, provider, ref]
		);
		return { admin, teamId };
	};
	const teamExists = async (id: string) => (await asOwner('SELECT 1 FROM team WHERE id = $1', [id])).length === 1;

	it('refuses with 503 team_plan_not_cancelled and deletes nothing when the provider can’t cancel it', async () => {
		const ref = `sub_TeamStuck${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
		const { admin, teamId } = await teamWithPlan('TeamPlanStuck', 'stripe', ref);
		const saved = { p: process.env.BILLING_PROVIDER, k: process.env.STRIPE_SECRET_KEY };
		process.env.BILLING_PROVIDER = 'stripe';
		delete process.env.STRIPE_SECRET_KEY;
		try {
			const res = await admin.call('DELETE', `/teams/${teamId}`);
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('team_plan_not_cancelled');
			// The team page shows the message as it is: what happened and what to do, never the provider's text.
			expect(res.body.error).toBe(
				'the team’s paid plan couldn’t be ended at the payment provider, so nothing was deleted; try again in a few minutes (the plan may already have ended, and then deleting the team goes through)'
			);
		} finally {
			if (saved.p === undefined) delete process.env.BILLING_PROVIDER;
			else process.env.BILLING_PROVIDER = saved.p;
			if (saved.k !== undefined) process.env.STRIPE_SECRET_KEY = saved.k;
		}
		expect(await teamExists(teamId)).toBe(true);
		expect(await asOwner('SELECT status FROM subscription WHERE external_ref = $1', [ref])).toEqual([{ status: 'active' }]);
		await asOwner('DELETE FROM subscription WHERE external_ref = $1', [ref]);
	});

	it('refuses with 503 team_plan_not_cancelled when no provider that can cancel is set up (manual, or another provider’s subscription)', async () => {
		const ref = `sub_TeamOther${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
		const { admin, teamId } = await teamWithPlan('TeamPlanNoProvider', 'stripe', ref);
		const saved = process.env.BILLING_PROVIDER;
		try {
			for (const provider of ['manual', 'mock']) {
				process.env.BILLING_PROVIDER = provider;
				const res = await admin.call('DELETE', `/teams/${teamId}`);
				expect(res.status, provider).toBe(503);
				expect(res.body.code, provider).toBe('team_plan_not_cancelled');
			}
		} finally {
			if (saved === undefined) delete process.env.BILLING_PROVIDER;
			else process.env.BILLING_PROVIDER = saved;
		}
		expect(await teamExists(teamId)).toBe(true);
		expect(await asOwner('SELECT status FROM subscription WHERE external_ref = $1', [ref])).toEqual([{ status: 'active' }]);
		expect(await asOwner(`SELECT 1 FROM audit_event WHERE kind = 'team.deleted' AND subject->>'teamId' = $1`, [teamId])).toEqual([]);
		await asOwner('DELETE FROM subscription WHERE external_ref = $1', [ref]);
	});

	it('deletes a team whose plan the provider cancels (the mock), the subscription going with it (positive control)', async () => {
		const ref = `sub_mock_team${crypto.randomUUID().replace(/-/g, '')}`;
		const { admin, teamId } = await teamWithPlan('TeamPlanGone', 'mock', ref);
		expect((await admin.call('DELETE', `/teams/${teamId}`)).status).toBe(204);
		expect(await teamExists(teamId)).toBe(false);
		expect(await asOwner('SELECT 1 FROM subscription WHERE external_ref = $1', [ref])).toEqual([]);
	});

	it('refuses with 503 team_plan_not_cancelled when a checkout completes while the plan is being cancelled, so its subscription is never orphaned', async () => {
		const ref = `sub_mock_teamrace${crypto.randomUUID().replace(/-/g, '')}`;
		const late = `sub_mock_teamlate${crypto.randomUUID().replace(/-/g, '')}`;
		const { admin, teamId } = await teamWithPlan('TeamPlanRace', 'mock', ref);
		race.onCancel = async (req) => {
			// During the provider's round trips the cancel's own webhook ends the old plan, and a checkout that completed
			// meanwhile lands a new live subscription the cancel didn't reach (one live per account: 323's index).
			await asOwner(`UPDATE subscription SET status = 'canceled' WHERE external_ref = $1`, [ref]);
			await asOwner(
				`INSERT INTO subscription (billing_account_id, plan_code, status, provider, external_ref, period_start, period_end)
				 VALUES ($1, 'team', 'active', 'mock', $2, now(), now() + interval '30 days')`,
				[req.accountId, late]
			);
			return [...req.subscriptionRefs];
		};
		try {
			const res = await admin.call('DELETE', `/teams/${teamId}`);
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('team_plan_not_cancelled');
		} finally {
			race.onCancel = null;
		}
		expect(await teamExists(teamId)).toBe(true);
		expect(await asOwner(`SELECT 1 FROM audit_event WHERE kind = 'team.deleted' AND subject->>'teamId' = $1`, [teamId])).toEqual([]);
		expect(await asOwner('SELECT status FROM subscription WHERE external_ref = $1', [late])).toEqual([{ status: 'active' }]);
		// Once that one ends too, the same request goes through (positive control).
		await asOwner(`UPDATE subscription SET status = 'canceled' WHERE external_ref = $1`, [late]);
		expect((await admin.call('DELETE', `/teams/${teamId}`)).status).toBe(204);
		expect(await teamExists(teamId)).toBe(false);
	});

	it('never asks the provider to cancel for someone who isn’t the team’s admin', async () => {
		const ref = `sub_mock_teamview${crypto.randomUUID().replace(/-/g, '')}`;
		const { admin, teamId } = await teamWithPlan('TeamPlanViewer', 'mock', ref);
		const editor = await signUp('TeamPlanEditor');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: editor.email, role: 'member' })).status).toBe(201);
		const calls: string[] = [];
		race.onCancel = async (req) => {
			calls.push(req.accountId);
			return [...req.subscriptionRefs];
		};
		try {
			expect((await editor.call('DELETE', `/teams/${teamId}`)).status).toBe(403);
		} finally {
			race.onCancel = null;
		}
		expect(calls).toEqual([]);
		expect(await teamExists(teamId)).toBe(true);
		expect(await asOwner('SELECT status FROM subscription WHERE external_ref = $1', [ref])).toEqual([{ status: 'active' }]);
	});
});
