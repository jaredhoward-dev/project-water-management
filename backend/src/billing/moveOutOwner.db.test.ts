// Who a project bills to when it leaves its team (400_project_leaves_team_billing; docs/billing.md § Who the plan
// belongs to). A personal project bills to its creator's account, but since leaving a team takes the leaver's direct
// roles on its projects (leaveProjects.ts, 2026-11-24) and only a team admin takes a project out (#900), the creator
// may no longer be on the project at all when it leaves: before 400 it still billed to them, so their Free plan
// counted a catchment they couldn't open, its live operations used their one live catchment (and the move was
// refused or their own catchments paused against a plan that wasn't the mover's).
//  - the creator still a direct owner: it bills to them (positive control, the rule as before);
//  - the creator gone from it: it bills to the person taking it out (who the route always makes a direct owner);
//  - with no signed-in person (the schema owner's SQL): its longest-standing direct owner.
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const billedTo = async (project: string) =>
	((await asOwner(
		`SELECT coalesce(a.user_id::text, 'team:' || a.team_id::text) AS who FROM project p JOIN billing_account a ON a.id = p.billing_account_id WHERE p.id = $1`,
		[project]
	)) as { who: string }[])[0]?.who;
const accountProjects = async (u: User) =>
	Number(((await asOwner('SELECT count(*) AS n FROM project p JOIN billing_account a ON a.id = p.billing_account_id WHERE a.user_id = $1', [u.id])) as { n: string }[])[0]!.n);

async function teamWithMaker(): Promise<{ admin: User; maker: User; teamId: string; pid: string }> {
	const [admin, maker] = (await Promise.all(['LeaveAdmin', 'LeaveMaker'].map((n) => signUp(n)))) as [User, User];
	const teamId = (await admin.call('POST', '/teams', { name: `Leaves ${crypto.randomUUID().slice(0, 8)}` })).body.team.id as string;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: maker.email, role: 'member' })).status).toBe(201);
	const pid = (await maker.call('POST', '/projects', { name: 'Made in the team', teamId })).body.project.id as string;
	expect(await billedTo(pid)).toBe(`team:${teamId}`);
	return { admin, maker, teamId, pid };
}

describe('a project leaving its team bills to someone on it', () => {
	it('to its creator while they are still a direct owner (positive control)', async () => {
		const { admin, maker, pid } = await teamWithMaker();
		const out = await admin.call('PATCH', `/projects/${pid}`, { teamId: null });
		expect(out.status).toBe(200);
		expect(await billedTo(pid)).toBe(maker.id);
	});

	it('to the admin taking it out once its creator has left the team (and the project)', async () => {
		const { admin, maker, teamId, pid } = await teamWithMaker();
		expect((await maker.call('DELETE', `/teams/${teamId}/members/${maker.id}`)).status).toBe(204);
		expect((await maker.call('GET', `/projects/${pid}`)).status).toBe(404);
		const before = await accountProjects(maker);
		const out = await admin.call('PATCH', `/projects/${pid}`, { teamId: null });
		expect(out.status).toBe(200);
		expect(await billedTo(pid)).toBe(admin.id);
		expect(await accountProjects(maker)).toBe(before);
	});

	it('to its longest-standing direct owner when the schema owner moves it with no one signed in', async () => {
		const { admin, maker, teamId, pid } = await teamWithMaker();
		expect((await maker.call('DELETE', `/teams/${teamId}/members/${maker.id}`)).status).toBe(204);
		await asOwner('UPDATE project SET team_id = NULL WHERE id = $1', [pid]);
		// The leave handed ownership to the team's admin (leaveProjects.ts): the one direct owner left.
		expect(await billedTo(pid)).toBe(admin.id);
	});
});
