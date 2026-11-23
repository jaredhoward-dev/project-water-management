// The billing routes against Postgres (issue #641 Phase 1, docs/billing.md):
// who reads which account's plan through the 323_billing definer functions,
// and the shadow counters a server report and an issued pack add to. Every
// "cannot see" check has a positive control. The functions' own SQL tests
// (limits, backfill, deletion) are billing.db.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { countUsage } from './entitlements.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User; // a person with a personal project, and the team's admin
let member: User; // a team member, not an admin
let teamViewer: User;
let farmer: User; // a farmer on a team project, not in the team
let stranger: User;
let teamId: string;
let personal: string; // owner's personal project, with a run
let teamProject: string;
let farmNode: string;

async function withRun(u: User, name: string, team: string | null = null) {
	const projectId = (await u.call('POST', '/projects', { name, teamId: team })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	expect((await u.call('POST', `/projects/${projectId}/runs`, {})).status).toBe(201);
	return { projectId, farmId: farm.id };
}

const usage = async (u: User, path = '/account/plan') => (await u.call('GET', path)).body.usage;

beforeAll(async () => {
	[owner, member, teamViewer, farmer, stranger] = (await Promise.all(['BillOwner', 'BillMember', 'BillViewer', 'BillFarmer', 'BillStranger'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	teamId = (await owner.call('POST', '/teams', { name: 'Billing WUA' })).body.team.id;
	expect((await owner.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
	expect((await owner.call('POST', `/teams/${teamId}/members`, { email: teamViewer.email, role: 'viewer' })).status).toBe(201);
	personal = (await withRun(owner, 'Billing personal')).projectId;
	const t = await withRun(owner, 'Billing team project', teamId);
	teamProject = t.projectId;
	farmNode = t.farmId;
	expect((await owner.call('POST', `/projects/${teamProject}/farmers`, { email: farmer.email, nodeIds: [farmNode] })).status).toBe(201);
}, 120_000);

afterAll(async () => {
	await retirePendingJobs(personal, teamProject);
});

describe('GET /billing/plans', () => {
	it('lists the three seeded plans to anyone, signed out included, in ZAR cents', async () => {
		const res = await anon('GET', '/billing/plans');
		expect(res.status).toBe(200);
		expect(res.body.plans.map((p: { code: string }) => p.code)).toEqual(['free', 'pro', 'team']);
		const pro = res.body.plans.find((p: { code: string }) => p.code === 'pro');
		expect(pro).toMatchObject({ name: expect.any(String), priceMonthlyMinor: 89900, priceAnnualMinor: 899000, currency: 'ZAR' });
		expect(pro.limits).toMatchObject({ catchments: 15, editors_per_project: 5, live_catchments: null });
		expect(Object.keys(pro).sort()).toEqual(['code', 'currency', 'features', 'limits', 'name', 'priceAnnualMinor', 'priceMonthlyMinor', 'trialDays']);
	});
});

describe('GET /account/plan', () => {
	it('is 401 signed out', async () => {
		expect((await anon('GET', '/account/plan')).status).toBe(401);
	});

	it('is the caller’s own account: Free with no subscription, its projects counted, not enforced', async () => {
		const res = await owner.call('GET', '/account/plan');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ account: { id: expect.any(String), kind: 'user' }, plan: { code: 'free' }, subscription: null, enforced: false });
		expect(res.body.usage.month).toMatch(/^\d{4}-\d{2}$/);
		// The personal project bills to its creator; the team project to the team.
		expect(res.body.usage.catchments.used).toBe(1);
		// Asked again, the same account (created once).
		expect((await owner.call('GET', '/account/plan')).body.account.id).toBe(res.body.account.id);
	});

	it('is each person’s own: another person’s account is not theirs (positive control: each sees one of their own)', async () => {
		const mine = (await owner.call('GET', '/account/plan')).body.account.id;
		const theirs = (await stranger.call('GET', '/account/plan')).body.account.id;
		expect(theirs).not.toBe(mine);
		expect(await withUser(stranger.id, async (db) => (await db.query('SELECT app_account_plan($1) AS p', [mine])).rows[0].p)).toBeNull();
		expect(await withUser(owner.id, async (db) => (await db.query('SELECT app_account_plan($1) AS p', [mine])).rows[0].p)).not.toBeNull();
	});

	it('says BILLING_ENFORCED', async () => {
		vi.stubEnv('BILLING_ENFORCED', 'true');
		try {
			expect((await owner.call('GET', '/account/plan')).body.enforced).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('GET /teams/:id/plan', () => {
	it('is the team account’s plan for its admin (positive control)', async () => {
		const res = await owner.call('GET', `/teams/${teamId}/plan`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ account: { kind: 'team' }, plan: { code: 'free' }, enforced: false });
		expect(res.body.usage.catchments.used).toBe(1);
		expect(res.body.account.id).not.toBe((await owner.call('GET', '/account/plan')).body.account.id);
	});

	it.each([
		['a team member who is not an admin', () => member],
		['a team viewer', () => teamViewer],
		['a farmer on a team project', () => farmer],
		['a stranger', () => stranger]
	])('is 404 for %s', async (_who, who) => {
		const res = await who().call('GET', `/teams/${teamId}/plan`);
		expect(res.status).toBe(404);
		expect(res.body.usage).toBeUndefined();
	});

	it('is 404 for a team that does not exist, or an id that is not one, and 401 signed out', async () => {
		expect((await owner.call('GET', `/teams/${crypto.randomUUID()}/plan`)).status).toBe(404);
		expect((await owner.call('GET', '/teams/nope/plan')).status).toBe(404);
		expect((await anon('GET', `/teams/${teamId}/plan`)).status).toBe(401);
	});
});

describe('shadow counting (nothing refused)', () => {
	it('a server report counts against the project’s account, once per report', async () => {
		const before = (await usage(owner)).reports.used as number;
		expect((await owner.call('POST', `/projects/${personal}/reports`, {})).status).toBe(202);
		expect((await usage(owner)).reports.used).toBe(before + 1);
		// The team's account didn't count it (positive control: the team's own report does).
		const teamBefore = (await usage(owner, `/teams/${teamId}/plan`)).reports.used as number;
		expect((await owner.call('POST', `/projects/${teamProject}/reports`, {})).status).toBe(202);
		expect((await usage(owner, `/teams/${teamId}/plan`)).reports.used).toBe(teamBefore + 1);
		expect((await usage(owner)).reports.used).toBe(before + 1);
	});

	it('Free’s monthly report limit is shown but not enforced: a report past it is still queued', async () => {
		const { limit } = (await usage(owner)).reports as { used: number; limit: number | null };
		expect(limit).toBe(5);
		const [{ id: account }] = await asOwner('SELECT billing_account_id AS id FROM project WHERE id = $1', [personal]);
		// Set the month's count to the limit directly, then queue one more: it goes through.
		await asOwner(
			`INSERT INTO usage_counter (billing_account_id, kind, month, qty)
			 VALUES ($1, 'reports', date_trunc('month', now() AT TIME ZONE 'Africa/Johannesburg')::date, $2)
			 ON CONFLICT (billing_account_id, kind, month) DO UPDATE SET qty = EXCLUDED.qty`,
			[account, limit]
		);
		expect((await owner.call('POST', `/projects/${personal}/reports`, {})).status).toBe(202);
		expect((await usage(owner)).reports.used).toBe(limit! + 1);
	});

	it('app_usage_add needs a role on the project: a stranger’s count is refused or lands nowhere (positive control: the owner’s counts)', async () => {
		const packs = async () => (await usage(owner)).packsIssued.used as number;
		const before = await packs();
		await withUser(owner.id, (db) => countUsage(db, personal, 'packs_issued'));
		expect(await packs()).toBe(before + 1);
		await withUser(stranger.id, (db) => countUsage(db, personal, 'packs_issued')).catch(() => undefined);
		expect(await packs()).toBe(before + 1);
	});
});
