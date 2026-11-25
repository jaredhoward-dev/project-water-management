// Who Compare plans may send to a team's plan (docs/billing.md § Who the plan belongs to; docs/ui.md): the project
// payload's `team.role` (app_team_role) is the caller's role in the project's team, null outside it, and the frontend
// (billing/planLink.ts) opens /teams/:id/plan only for `admin`. This pins the field against what GET /teams/:id/plan
// actually answers each caller: 200 for the admin (positive control), 404 for a member, a viewer and someone shared
// the project directly outside the team, so the field never says "admin" to someone the plan page refuses.
import { describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';

describe('project.team.role matches who reads the team’s plan', () => {
	it('admin: role admin and the team plan opens; member, viewer and a direct member: not admin and a 404', async () => {
		const admin = await signUp('PlanRoleAdmin');
		const member = await signUp('PlanRoleMember');
		const viewer = await signUp('PlanRoleViewer');
		const direct = await signUp('PlanRoleDirect');
		const teamId = (await admin.call('POST', '/teams', { name: 'Plan role WUA' })).body.team.id as string;
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const created = await admin.call('POST', '/projects', { name: 'Plan role catchment', teamId });
		expect(created.status).toBe(201);
		expect(created.body.project.team).toEqual({ id: teamId, name: 'Plan role WUA', role: 'admin' });
		const id = created.body.project.id as string;
		expect((await admin.call('POST', `/projects/${id}/members`, { email: direct.email, role: 'editor' })).status).toBe(201);

		const cases = [
			{ who: admin, team: { id: teamId, name: 'Plan role WUA', role: 'admin' }, plan: 200 },
			{ who: member, team: { id: teamId, name: 'Plan role WUA', role: 'member' }, plan: 404 },
			{ who: viewer, team: { id: teamId, name: 'Plan role WUA', role: 'viewer' }, plan: 404 },
			// Shared the project directly, outside the team: no team name (team RLS) and no role.
			{ who: direct, team: { id: teamId, name: null, role: null }, plan: 404 }
		];
		for (const c of cases) {
			const got = await c.who.call('GET', `/projects/${id}`);
			expect(got.status).toBe(200);
			expect(got.body.project.team).toEqual(c.team);
			expect((await c.who.call('GET', `/teams/${teamId}/plan`)).status).toBe(c.plan);
		}
	});

	it('a personal project has no team, and the list’s summary carries no role', async () => {
		const owner = await signUp('PlanRolePersonal');
		const personal = await owner.call('POST', '/projects', { name: 'Plan role personal' });
		expect(personal.body.project.team).toBeNull();
		const teamId = (await owner.call('POST', '/teams', { name: 'Plan role list WUA' })).body.team.id as string;
		const teamProject = (await owner.call('POST', '/projects', { name: 'Plan role listed', teamId })).body.project.id as string;
		const list = await owner.call('GET', '/projects');
		expect(list.status).toBe(200);
		const row = (list.body.projects as { id: string; team: unknown }[]).find((p) => p.id === teamProject)!;
		expect(row.team).toEqual({ id: teamId, name: 'Plan role list WUA' });
	});
});
