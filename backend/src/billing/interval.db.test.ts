// 332_subscription_interval (issue #641): what a subscription costs and how many editors a team has.
//  - app_billing_apply stores the payload's interval from monthly and yearly events; an event without one keeps the
//    stored value, null clears it, anything else is invalid and changes nothing;
//  - app_account_plan shows subscription.interval (null for a row with none, like the staff grant's), and, on a team
//    account, team.editorCount: the distinct people with editor or owner on the team's projects, through the team or
//    as direct members, each once; team viewers, project viewers, contributors and farmers hold no seat, nor does an
//    editor of another team's project. The admin reads it (positive control); a team member reads no plan at all.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Plan = { subscription: { interval: string | null; seats: number } | null; team: { editorCount: number } | null } | null;

let person: User;
let account: string;
let admin: User;
let member: User;
let teamViewer: User;
let directEditor: User;
let directOwner: User;
let directViewer: User;
let farmer: User;
let contributor: User;
let elsewhere: User;
let teamId: string;
let otherTeamId: string;
let teamAccount: string;

const apply = (type: string, payload: unknown) =>
	withoutUser(
		async (db) =>
			(await db.query<{ r: string }>('SELECT app_billing_apply($1, $2, $3, $4::jsonb) AS r', ['mock', `evt_${randomUUID()}`, type, JSON.stringify(payload)])).rows[0]!.r
	);
const stored = async (ref: string) =>
	((await asOwner('SELECT billing_interval FROM subscription WHERE provider = $1 AND external_ref = $2', ['mock', ref])) as { billing_interval: string | null }[])[0]
		?.billing_interval;
const planOf = (u: User, acct: string) => withUser(u.id, async (db) => (await db.query<{ v: Plan }>('SELECT app_account_plan($1) AS v', [acct])).rows[0]!.v);
const payload = (acct: string, ref: string, over: Record<string, unknown> = {}) => ({
	accountId: acct,
	planCode: 'pro',
	status: 'active',
	seats: 1,
	periodStart: '2026-11-01T00:00:00Z',
	periodEnd: '2026-12-01T00:00:00Z',
	trialEnd: null,
	cancelAtPeriodEnd: false,
	externalRef: ref,
	...over
});
const teamProject = async (team: string, name: string) =>
	((await asOwner(`INSERT INTO project (name, created_by, team_id) VALUES ($1, $2, $3) RETURNING id`, [name, admin.id, team])) as { id: string }[])[0]!.id;
const projectRole = (project: string, u: User, role: string) =>
	asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3::project_role)`, [project, u.id, role]);
const teamRole = (team: string, u: User, role: string) => asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, $3::team_role)`, [team, u.id, role]);

beforeAll(async () => {
	[person, admin, member, teamViewer, directEditor, directOwner, directViewer, farmer, contributor, elsewhere] = (await Promise.all(
		['IntPerson', 'IntAdmin', 'IntMember', 'IntTeamViewer', 'IntDirectEditor', 'IntDirectOwner', 'IntDirectViewer', 'IntFarmer', 'IntContributor', 'IntElsewhere'].map((n) =>
			signUp(n)
		)
	)) as User[] as [User, User, User, User, User, User, User, User, User, User];
	account = await withUser(person.id, async (db) => (await db.query<{ id: string }>('SELECT app_my_billing_account() AS id')).rows[0]!.id);

	teamId = (await admin.call('POST', '/teams', { name: 'Interval WUA' })).body.team.id;
	otherTeamId = (await elsewhere.call('POST', '/teams', { name: 'Interval other WUA' })).body.team.id;
	await teamRole(teamId, member, 'member');
	await teamRole(teamId, teamViewer, 'viewer');
	const [a, b] = [await teamProject(teamId, 'Interval team A'), await teamProject(teamId, 'Interval team B')];
	const other = await teamProject(otherTeamId, 'Interval other team');
	// Direct members of the team's projects: an editor on both (counted once), an owner, and roles that hold no seat.
	await projectRole(a, directEditor, 'editor');
	await projectRole(b, directEditor, 'editor');
	await projectRole(b, directOwner, 'owner');
	await projectRole(a, directViewer, 'viewer');
	await projectRole(a, farmer, 'farmer');
	await projectRole(a, contributor, 'contributor');
	// A team member who is also a direct editor counts once.
	await projectRole(b, member, 'editor');
	// An editor of another team's project holds no seat here.
	await projectRole(other, directViewer, 'editor');
	teamAccount = await withUser(admin.id, async (db) => (await db.query<{ v: string }>('SELECT app_team_billing_account($1) AS v', [teamId])).rows[0]!.v);
});

afterAll(async () => {
	await asOwner('DELETE FROM subscription WHERE billing_account_id = ANY($1)', [[account, teamAccount]]);
	await asOwner('DELETE FROM billing_event WHERE account_id = ANY($1)', [[account, teamAccount]]);
});

describe('subscription.billing_interval (332)', () => {
	it('stores the interval from a monthly event and then a yearly one, and the plan shows it to the account', async () => {
		const ref = `sub_int_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, ref, { interval: 'month' }))).toBe('applied');
		expect(await stored(ref)).toBe('month');
		expect((await planOf(person, account))?.subscription?.interval).toBe('month');
		expect(await apply('subscription.updated', payload(account, ref, { interval: 'year', periodEnd: '2027-11-01T00:00:00Z' }))).toBe('applied');
		expect(await stored(ref)).toBe('year');
		expect((await planOf(person, account))?.subscription?.interval).toBe('year');

		// No interval in the payload (an older sender): the stored one stays. Null clears it.
		expect(await apply('subscription.updated', payload(account, ref, { cancelAtPeriodEnd: true }))).toBe('applied');
		expect(await stored(ref)).toBe('year');
		expect(await apply('subscription.updated', payload(account, ref, { interval: null }))).toBe('applied');
		expect(await stored(ref)).toBeNull();
		expect((await planOf(person, account))?.subscription).toMatchObject({ interval: null });

		// Anything but month, year or null is invalid and changes nothing.
		for (const bad of ['week', 'monthly', 1, true, {}]) expect(await apply('subscription.updated', payload(account, ref, { interval: bad })), String(bad)).toBe('invalid');
		expect(await stored(ref)).toBeNull();
		await apply('subscription.deleted', payload(account, ref));
	});

	it('a subscription created with no interval (the staff grant’s, a row before 332) reads null; a person’s plan has no team', async () => {
		const ref = `sub_int_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, ref))).toBe('applied');
		expect(await stored(ref)).toBeNull();
		const plan = await planOf(person, account);
		expect(plan?.subscription).toMatchObject({ interval: null, seats: 1 });
		expect(plan?.team).toBeNull();
		await apply('subscription.deleted', payload(account, ref));
	});
});

describe('team.editorCount (332)', () => {
	it('counts team members and admins and direct editors and owners of the team’s projects, each once (positive control: the admin reads it)', async () => {
		// admin, member (also a direct editor), directEditor (on two projects), directOwner: 4.
		const plan = await planOf(admin, teamAccount);
		expect(plan?.team).toEqual({ editorCount: 4 });
	});

	it('excludes team viewers, project viewers, contributors and farmers, until one is made an editor', async () => {
		await projectRole(await teamProject(teamId, 'Interval team C'), teamViewer, 'editor');
		expect((await planOf(admin, teamAccount))?.team).toEqual({ editorCount: 5 });
		await asOwner(`DELETE FROM project_member WHERE user_id = $1`, [teamViewer.id]);
		expect((await planOf(admin, teamAccount))?.team).toEqual({ editorCount: 4 });
	});

	it('a team member, a direct editor and an outsider read no plan, so no count', async () => {
		for (const u of [member, directEditor, elsewhere]) expect(await planOf(u, teamAccount), u.email).toBeNull();
	});
});
