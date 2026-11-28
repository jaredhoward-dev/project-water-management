// 345_plan_keep_picker (issue #641 § Downgrade or lapse; docs/billing.md § Choosing the catchment to keep): the Plan
// page's live-catchment picker over 341's pause.
//  - GET /account/plan/live-catchments lists the account's live catchments for its person, with which stays live, and
//    whether a plan ended past Free's limit (409, planEnded) and when the grace started (null in shadow mode); a stranger can't read another's (no route names another account), and a
//    team's list is its admins' only (a member, positive control: the admin, gets it);
//  - POST /account/plan/keep: the owner chooses, and past the grace, enforced, the pause moves at once;
//  - a project that isn't one of the account's live catchments, a stranger's choice and a team member's are all 404;
//  - a bad body is 400 after the access check;
//  - a catchment of another account the caller can use (a team admin's own, the team's) is 404 through either route;
//  - GET /projects/:id says when the project was paused (the workspace's notice), and null on the kept one.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, disableFeedsAfterFile, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

const alertBody = { rules: [{ kind: 'ewr_forecast_fail', threshold: 5, enabled: true }] };
const made: string[] = [];
const newProject = async (u: User, name: string, teamId?: string) => {
	const r = await u.call('POST', '/projects', teamId ? { name, teamId } : { name });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	const id = r.body.project.id as string;
	made.push(id);
	expect((await u.call('PUT', `/projects/${id}/alert-rules`, alertBody)).status).toBe(200);
	return id;
};
const accountOf = async (pid: string) =>
	((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid])) as { a: string }[])[0]!.a;
const paused = async (account: string) =>
	((await asOwner('SELECT pp.project_id AS id FROM project_plan_pause pp JOIN project p ON p.id = pp.project_id WHERE p.billing_account_id = $1 ORDER BY 1', [
		account
	])) as { id: string }[]).map((r) => r.id);
const lapse = async (account: string) => {
	await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'canceled', 'mock')`, [account]);
	await asOwner(`UPDATE billing_account SET over_free_since = now() - interval '15 days' WHERE id = $1`, [account]);
};
const tick = () => runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });

disableFeedsAfterFile();
afterEach(() => {
	delete process.env.BILLING_ENFORCED;
});
afterAll(() => retirePendingJobs(...made));

describe('345: the live-catchment picker on the Plan page', () => {
	let owner: User;
	let stranger: User;
	let a: string;
	let b: string;
	let idle: string;
	let account: string;

	beforeAll(async () => {
		owner = await signUp('KeepOwner');
		stranger = await signUp('KeepStranger');
		a = await newProject(owner, 'Keep A');
		b = await newProject(owner, 'Keep B');
		// Not live: no feed, alert, automatic runs or publication.
		idle = (await owner.call('POST', '/projects', { name: 'Keep idle' })).body.project.id as string;
		made.push(idle);
		account = await accountOf(a);
		// B is the most recently active.
		await asOwner(`UPDATE project SET updated_at = now() - interval '1 day' WHERE id = $1`, [a]);
	});

	it('an account that never had a plan lists its live catchments, with no grace', async () => {
		const r = await owner.call('GET', '/account/plan/live-catchments');
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ freeLimit: 1, planEnded: false, overFreeSince: null, pausesFrom: null });
		expect(r.body.catchments.map((c: { id: string }) => c.id)).toEqual([b, a]);
		expect(r.body.catchments[0]).toEqual({ id: b, name: 'Keep B', chosen: false, staysLive: true, pausedAt: null });
	});

	it('the stranger sees only their own (empty) list, never the owner’s catchments', async () => {
		const r = await stranger.call('GET', '/account/plan/live-catchments');
		expect(r.status).toBe(200);
		expect(r.body.catchments).toEqual([]);
	});

	it('past the grace, enforced, the pause moves to follow the owner’s choice at once', async () => {
		await lapse(account);
		// Shadow mode (409): the plan has ended, but no grace runs, so no pause date is given.
		await tick();
		const shadow = await owner.call('GET', '/account/plan/live-catchments');
		expect(shadow.body).toMatchObject({ planEnded: true, overFreeSince: null, pausesFrom: null });
		await asOwner(`UPDATE billing_account SET over_free_since = now() - interval '15 days' WHERE id = $1`, [account]);
		process.env.BILLING_ENFORCED = 'true';
		await tick();
		expect(await paused(account)).toEqual([a]);
		const before = await owner.call('GET', '/account/plan/live-catchments');
		expect(before.body.overFreeSince).not.toBeNull();
		expect(before.body.planEnded).toBe(true);
		expect(before.body.catchments.find((c: { id: string }) => c.id === a).pausedAt).not.toBeNull();
		expect((await owner.call('GET', `/projects/${a}`)).body.project.planPausedAt).not.toBeNull();
		expect((await owner.call('GET', `/projects/${b}`)).body.project.planPausedAt).toBeNull();

		const r = await owner.call('POST', '/account/plan/keep', { projectId: a });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.catchments[0]).toMatchObject({ id: a, chosen: true, staysLive: true, pausedAt: null });
		expect(r.body.catchments[1]).toMatchObject({ id: b, chosen: false, staysLive: false });
		expect(r.body.catchments[1].pausedAt).not.toBeNull();
		expect(await paused(account)).toEqual([b]);
		expect((await owner.call('GET', `/projects/${a}`)).body.project.planPausedAt).toBeNull();
		expect((await owner.call('GET', `/projects/${b}`)).body.project.planPausedAt).not.toBeNull();
	});

	it('a stranger can’t choose for the account: 404, and the choice stays', async () => {
		process.env.BILLING_ENFORCED = 'true';
		// The stranger's own account has no such catchment: the same 404 as a project that doesn't exist.
		expect((await stranger.call('POST', '/account/plan/keep', { projectId: b })).status).toBe(404);
		expect((await stranger.call('POST', '/account/plan/keep', { projectId: crypto.randomUUID() })).status).toBe(404);
		expect(await paused(account)).toEqual([b]);
	});

	it('a catchment that isn’t live is 404; a bad body is 400', async () => {
		expect((await owner.call('POST', '/account/plan/keep', { projectId: idle })).status).toBe(404);
		expect((await owner.call('POST', '/account/plan/keep', { projectId: 'nope' })).status).toBe(400);
		expect((await owner.call('POST', '/account/plan/keep', { projectId: a, extra: 1 })).status).toBe(400);
		expect((await owner.call('POST', '/account/plan/keep', {})).status).toBe(400);
	});

	it('the paused project’s notice is every member’s: a viewer reads it too', async () => {
		process.env.BILLING_ENFORCED = 'true';
		const viewer = await signUp('KeepViewer');
		expect((await owner.call('POST', `/projects/${b}/members`, { email: viewer.email, role: 'viewer' })).status).toBeLessThan(300);
		const r = await viewer.call('GET', `/projects/${b}`);
		expect(r.status).toBe(200);
		expect(r.body.project.planPausedAt).not.toBeNull();
	});
});

describe('345: a team’s picker is its admins’ only', () => {
	let admin: User;
	let member: User;
	let teamId: string;
	let p: string;

	beforeAll(async () => {
		admin = await signUp('KeepTeamAdmin');
		member = await signUp('KeepTeamMember');
		const t = await admin.call('POST', '/teams', { name: `Keep team ${crypto.randomUUID().slice(0, 8)}` });
		expect(t.status).toBe(201);
		teamId = t.body.team.id as string;
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBeLessThan(300);
		p = await newProject(admin, 'Keep team P', teamId);
	});

	it('the admin lists and chooses (positive control)', async () => {
		const r = await admin.call('GET', `/teams/${teamId}/plan/live-catchments`);
		expect(r.status).toBe(200);
		expect(r.body.catchments.map((c: { id: string }) => c.id)).toEqual([p]);
		expect((await admin.call('POST', `/teams/${teamId}/plan/keep`, { projectId: p })).status).toBe(200);
	});

	it('a member and a stranger meet 404 on both, whatever the body', async () => {
		const stranger = await signUp('KeepTeamStranger');
		for (const u of [member, stranger]) {
			expect((await u.call('GET', `/teams/${teamId}/plan/live-catchments`)).status).toBe(404);
			expect((await u.call('POST', `/teams/${teamId}/plan/keep`, { projectId: p })).status).toBe(404);
			expect((await u.call('POST', `/teams/${teamId}/plan/keep`, { bad: true })).status).toBe(404);
		}
		expect((await admin.call('GET', '/teams/not-a-team/plan/live-catchments')).status).toBe(404);
	});

	// The cross-account pair (cross-project-refs.security.db.test.ts's inventory points here for billing/routes.ts:projectId):
	// the admin can use both catchments, so only the account each belongs to stops it, in either direction.
	it('a catchment is chosen only through its own account’s route, in either direction', async () => {
		const own = await newProject(admin, 'Keep admin own');
		const kept = async (accountOfProject: string) =>
			((await asOwner('SELECT kept_project_id AS k FROM billing_account WHERE id = $1', [await accountOf(accountOfProject)])) as { k: string | null }[])[0]!.k;
		// Positive controls: each through its own account's route.
		expect((await admin.call('POST', '/account/plan/keep', { projectId: own })).status).toBe(200);
		expect((await admin.call('POST', `/teams/${teamId}/plan/keep`, { projectId: p })).status).toBe(200);
		// Crossed: 404, and neither account's choice moves.
		expect((await admin.call('POST', '/account/plan/keep', { projectId: p })).status).toBe(404);
		expect((await admin.call('POST', `/teams/${teamId}/plan/keep`, { projectId: own })).status).toBe(404);
		expect(await kept(own)).toBe(own);
		expect(await kept(p)).toBe(p);
	});
});
