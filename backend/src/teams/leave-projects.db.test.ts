// Leaving a team, or being removed from it, takes the person's direct roles on
// the team's projects too, the ones they created included; a project they
// alone owned directly passes to a team admin, so the keep-owner trigger
// stays satisfied (teams/leaveProjects.ts, operator decision 2026-11-24;
// docs/security.md § Authorization → Teams). Their own projects outside the
// team are untouched (the positive control). A concurrent leave is raced the
// way last-owner-race.db.test.ts does it: a third connection holds the team's
// removal lock (lockTeamLeave), both requests queue behind it, then it lets go.
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
const tag = crypto.randomUUID().slice(0, 8);

const open: pg.Client[] = [];
async function ownerClient(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await c.connect();
	open.push(c);
	return c;
}
afterEach(async () => {
	for (const c of open.splice(0)) await c.end().catch(() => undefined);
});

const direct = async (pid: string) =>
	Object.fromEntries(
		(await asOwner(`SELECT user_id, role FROM project_member WHERE project_id = $1`, [pid])).map((r) => [r.user_id as string, r.role as string])
	);
const events = async (pid: string, kind: string) =>
	(await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = $2 ORDER BY id`, [pid, kind])).map((r) => r.subject as Record<string, unknown>);

/** A team created by `admin`, with `creator` a plain member (editor on its projects) who made one team project, and a project of their own. */
async function teamWithCreator(name: string) {
	const [admin, creator] = (await Promise.all([`${name}Admin`, `${name}Creator`].map((n) => signUp(n)))) as [User, User];
	const teamId = (await admin.call('POST', '/teams', { name: `${name} ${tag}` })).body.team.id as string;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: creator.email, role: 'member' })).status).toBe(201);
	const teamProject = (await creator.call('POST', '/projects', { name: `${name} team project`, teamId })).body.project.id as string;
	const ownProject = (await creator.call('POST', '/projects', { name: `${name} own project` })).body.project.id as string;
	expect(await direct(teamProject)).toEqual({ [creator.id]: 'owner' });
	return { admin, creator, teamId, teamProject, ownProject };
}

describe('a removed member loses the team’s projects, the ones they created included', () => {
	it('removed by an admin: the creator loses access, the admin owns it directly, and their own project stays (positive control)', async () => {
		const { admin, creator, teamId, teamProject, ownProject } = await teamWithCreator('LeaveRemoved');
		expect((await creator.call('GET', `/projects/${teamProject}`)).status).toBe(200);

		expect((await admin.call('DELETE', `/teams/${teamId}/members/${creator.id}`)).status).toBe(204);

		// The creator: no access, no direct row left.
		expect((await creator.call('GET', `/projects/${teamProject}`)).status).toBe(404);
		// The removing admin owns it, through the team and directly (the keep-owner trigger's direct owner).
		expect(await direct(teamProject)).toEqual({ [admin.id]: 'owner' });
		expect((await admin.call('GET', `/projects/${teamProject}`)).body.project.role).toBe('owner');
		// Recorded in the same transaction: the hand-off, then the removal.
		expect(await events(teamProject, 'member.added')).toContainEqual(expect.objectContaining({ userId: admin.id, role: 'owner', handedFrom: 'LeaveRemovedCreator' }));
		expect(await events(teamProject, 'member.removed')).toEqual([
			expect.objectContaining({ userId: creator.id, role: 'owner', self: false, leftTeam: true, team: `LeaveRemoved ${tag}` })
		]);
		// Positive control: the creator's project outside the team is untouched.
		expect(await direct(ownProject)).toEqual({ [creator.id]: 'owner' });
		expect((await creator.call('GET', `/projects/${ownProject}`)).body.project.role).toBe('owner');
	});

	it('leaving: ownership passes to the team’s longest-standing other admin; a direct share is dropped; a farmer row stays', async () => {
		const { admin, creator, teamId, teamProject } = await teamWithCreator('LeaveSelf');
		// A second admin who joined later, and a second team project the creator was only shared on as editor.
		const later = await signUp('LeaveSelfLater');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: later.email, role: 'admin' })).status).toBe(201);
		const shared = (await admin.call('POST', '/projects', { name: 'LeaveSelf shared', teamId })).body.project.id as string;
		await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'editor')`, [shared, creator.id]);

		expect((await creator.call('DELETE', `/teams/${teamId}/members/${creator.id}`)).status).toBe(204);

		expect(await direct(teamProject)).toEqual({ [admin.id]: 'owner' });
		expect(await direct(shared)).toEqual({ [admin.id]: 'owner' });
		for (const pid of [teamProject, shared]) expect((await creator.call('GET', `/projects/${pid}`)).status).toBe(404);
		expect(await events(shared, 'member.removed')).toEqual([expect.objectContaining({ userId: creator.id, role: 'editor', self: true, leftTeam: true })]);
		// Nothing handed on the shared project: the admin already owned it directly.
		expect((await events(shared, 'member.added')).filter((s) => s.handedFrom)).toEqual([]);
	});

	it('an admin with a direct editor row is raised to owner rather than added twice', async () => {
		const { admin, creator, teamId, teamProject } = await teamWithCreator('LeaveRaise');
		const other = await signUp('LeaveRaiseOther');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: other.email, role: 'admin' })).status).toBe(201);
		await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'editor')`, [teamProject, other.id]);
		expect((await other.call('DELETE', `/teams/${teamId}/members/${creator.id}`)).status).toBe(204);
		expect(await direct(teamProject)).toEqual({ [other.id]: 'owner' });
		expect(await events(teamProject, 'member.role')).toContainEqual(expect.objectContaining({ userId: other.id, from: 'editor', to: 'owner', handedFrom: 'LeaveRaiseCreator' }));
	});

	it('no hand-off while another direct owner stays', async () => {
		const { admin, creator, teamId, teamProject } = await teamWithCreator('LeaveCoOwned');
		const outsider = await signUp('LeaveCoOwnedOutsider');
		expect((await creator.call('POST', `/projects/${teamProject}/members`, { email: outsider.email, role: 'owner' })).status).toBe(201);
		expect((await admin.call('DELETE', `/teams/${teamId}/members/${creator.id}`)).status).toBe(204);
		expect(await direct(teamProject)).toEqual({ [outsider.id]: 'owner' });
	});

	it('your own id in capitals is still you: leaving, not removing someone (no team admin needed)', async () => {
		const { creator, teamId, teamProject } = await teamWithCreator('LeaveUpper');
		expect((await creator.call('DELETE', `/teams/${teamId}/members/${creator.id.toUpperCase()}`)).status).toBe(204);
		expect((await creator.call('GET', `/projects/${teamProject}`)).status).toBe(404);
		expect(await asOwner(`SELECT 1 FROM team_member WHERE team_id = $1 AND user_id = $2`, [teamId, creator.id])).toEqual([]);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'team_member.removed'`, [teamProject]);
		expect(ev!.subject).toMatchObject({ self: true });
	});

	it('the project route too: an editor leaving with their id in capitals leaves (it was a 403 for not being an owner)', async () => {
		const [owner, editor] = (await Promise.all(['UpperOwner', 'UpperEditor'].map((n) => signUp(n)))) as [User, User];
		const pid = (await owner.call('POST', '/projects', { name: `Upper ${tag}` })).body.project.id as string;
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		expect((await editor.call('DELETE', `/projects/${pid}/members/${editor.id.toUpperCase()}`)).status).toBe(204);
		expect(await direct(pid)).toEqual({ [owner.id]: 'owner' });
		expect(await events(pid, 'member.removed')).toEqual([expect.objectContaining({ userId: editor.id, self: true })]);
	});
});

describe('a concurrent leave', () => {
	async function waitForLockWaiters(monitor: pg.Client, n: number): Promise<void> {
		for (let i = 0; i < 1000; i++) {
			const { rows } = await monitor.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
			);
			if (rows[0]!.n >= n) return;
			await new Promise((r) => setTimeout(r, 5));
		}
		throw new Error(`never saw ${n} sessions waiting on a lock`);
	}

	it('the creator and the admin who would receive the project leave at once: either order, the remaining admin owns it directly', async () => {
		const { admin, creator, teamId, teamProject, ownProject } = await teamWithCreator('LeaveRace');
		const second = await signUp('LeaveRaceSecond');
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: second.email, role: 'admin' })).status).toBe(201);

		// Hold the team's removal lock (lockTeamLeave), so both requests queue behind it, then let go.
		const blocker = await ownerClient();
		const monitor = await ownerClient();
		await blocker.query('BEGIN');
		await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('team_leave:' || $1::text, 0))`, [teamId]);
		const both = [creator.call('DELETE', `/teams/${teamId}/members/${creator.id}`), admin.call('DELETE', `/teams/${teamId}/members/${admin.id}`)];
		await waitForLockWaiters(monitor, 2);
		await blocker.query('ROLLBACK');
		const results = await Promise.all(both);

		expect(results.map((r) => r.status)).toEqual([204, 204]);
		// Whichever went first, the project ends with the one admin left as its direct owner: never none.
		expect(await direct(teamProject)).toEqual({ [second.id]: 'owner' });
		expect((await second.call('GET', `/projects/${teamProject}`)).body.project.role).toBe('owner');
		for (const u of [creator, admin]) expect((await u.call('GET', `/projects/${teamProject}`)).status).toBe(404);
		expect(await asOwner(`SELECT user_id FROM team_member WHERE team_id = $1`, [teamId])).toEqual([{ user_id: second.id }]);
		// Positive control: the creator's own project is untouched.
		expect(await direct(ownProject)).toEqual({ [creator.id]: 'owner' });
	});
});
