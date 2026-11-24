// Checkout and the portal against Postgres (issue #641 Phase 3,
// docs/billing.md § Checkout and portal): who may start them (the person
// for their own account; a team's admins for the team's, 404 to its members,
// viewers, a farmer on its project and a stranger, each with a positive
// control), and that the mock's "pays" ends with the account's subscription
// live, through the real webhook route and app_billing_apply. Then 328's
// customer functions: the first stored customer wins, and only the account's
// own people read or write it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
/** Customer ids unique to this run: the test database outlives it, and the column is unique. */
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const cus = (name: string) => `cus_${name}${run}`;
type User = Awaited<ReturnType<typeof signUp>>;

let admin: User;
let member: User;
let viewer: User;
let farmer: User;
let stranger: User;
let buyer: User;
let teamId: string;

const sqlState = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return (e as { code?: string }).code ?? String(e);
	}
};
/** The mock page's path and query (the URL's origin is the request's own). */
const local = (url: string) => {
	const u = new URL(url);
	return `${u.pathname}${u.search}`;
};
const formPost = (path: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });

beforeAll(async () => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
	[admin, member, viewer, farmer, stranger, buyer] = (await Promise.all(
		['CoAdmin', 'CoMember', 'CoViewer', 'CoFarmer', 'CoStranger', 'CoBuyer'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: 'Checkout WUA' })).body.team.id;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	// A farmer on the team's project, not in the team.
	const projectId = (await admin.call('POST', '/projects', { name: 'Checkout team project', teamId })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await admin.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await admin.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
}, 120_000);

afterAll(() => {
	vi.unstubAllEnvs();
});

describe('who may start checkout and the portal', () => {
	it('a team’s: its admin (positive control); 404 to a member, a viewer, a farmer on its project and a stranger', async () => {
		const ok = await admin.call('POST', `/teams/${teamId}/plan/checkout`, { plan: 'team', interval: 'month' });
		expect(ok.status).toBe(200);
		expect(ok.body.url).toContain('/billing/mock/checkout?t=');
		expect((await admin.call('POST', `/teams/${teamId}/plan/portal`)).status).toBe(200);
		for (const u of [member, viewer, farmer, stranger]) {
			expect((await u.call('POST', `/teams/${teamId}/plan/checkout`, { plan: 'team', interval: 'month' })).status, u.email).toBe(404);
			expect((await u.call('POST', `/teams/${teamId}/plan/portal`)).status, u.email).toBe(404);
		}
	});

	it('your own: always yours, for Pro only', async () => {
		expect((await farmer.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' })).status).toBe(200);
		expect((await stranger.call('POST', '/account/plan/checkout', { plan: 'team', interval: 'month' })).status).toBe(400);
	});

	it('the portal takes no fields: a body sent is checked (400), none or an empty one opens it (positive control)', async () => {
		expect((await stranger.call('POST', '/account/plan/portal')).status).toBe(200);
		expect((await stranger.call('POST', '/account/plan/portal', {})).status).toBe(200);
		expect((await stranger.call('POST', '/account/plan/portal', { plan: 'pro' })).status).toBe(400);
		const nul = await app.request('/account/plan/portal', {
			method: 'POST',
			headers: { cookie: stranger.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: JSON.stringify({ note: 'a\u0000b' })
		});
		expect(nul.status).toBe(400);
		expect(await nul.json()).toMatchObject({ code: 'body_refused' });
	});
});

describe('the mock checkout, end to end', () => {
	it('pays: the account’s subscription is live on Pro, written by app_billing_apply; a second checkout is refused; the portal cancels at the period end', async () => {
		const start = await buyer.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' });
		expect(start.status).toBe(200);
		const page = await app.request(local(start.body.url));
		expect(page.status).toBe(200);

		// Cancels first: nothing changes.
		const cancelled = await formPost(`${local(start.body.url)}&outcome=cancels`);
		expect(cancelled.status).toBe(303);
		expect(cancelled.headers.get('location')).toMatch(/\/account\/plan\?checkout=cancelled$/);
		expect((await buyer.call('GET', '/account/plan')).body.subscription).toBeNull();

		const paid = await formPost(`${local(start.body.url)}&outcome=pays`);
		expect(paid.status).toBe(303);
		expect(paid.headers.get('location')).toMatch(/\/account\/plan\?checkout=done$/);
		const plan = (await buyer.call('GET', '/account/plan')).body;
		expect(plan.plan.code).toBe('pro');
		expect(plan.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: false, seats: 1 });
		const accountId = plan.account.id as string;
		const [row] = await asOwner('SELECT provider, external_ref FROM subscription WHERE billing_account_id = $1', [accountId]);
		expect(row).toEqual({ provider: 'mock', external_ref: `sub_mock_${accountId.replace(/-/g, '')}` });
		const events = await asOwner('SELECT type, outcome FROM billing_event WHERE account_id = $1 ORDER BY received_at, type', [accountId]);
		expect(events.map((e) => e.type).sort()).toEqual(['checkout.completed', 'subscription.updated']);

		expect((await buyer.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' })).status).toBe(409);

		const portal = await buyer.call('POST', '/account/plan/portal');
		expect(portal.status).toBe(200);
		expect(await (await app.request(local(portal.body.url))).text()).toContain('data-action="cancel"');
		const back = await formPost(`${local(portal.body.url)}&action=cancel`);
		expect(back.status).toBe(303);
		expect((await buyer.call('GET', '/account/plan')).body.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
	});

	it('Team with 5 seats: the subscription holds 5 seats, and the pooled assistant allowance is 5 × $15', async () => {
		const seatsTeam = (await admin.call('POST', '/teams', { name: 'Checkout seats WUA' })).body.team.id as string;
		expect((await admin.call('POST', `/teams/${seatsTeam}/plan/checkout`, { plan: 'team', interval: 'month', seats: 2 })).status).toBe(400);
		const start = await admin.call('POST', `/teams/${seatsTeam}/plan/checkout`, { plan: 'team', interval: 'month', seats: 5 });
		expect(start.status).toBe(200);
		expect(await (await app.request(local(start.body.url))).text()).toContain('data-mock-seats="5"');
		const paid = await formPost(`${local(start.body.url)}&outcome=pays`);
		expect(paid.status).toBe(303);
		expect(paid.headers.get('location')).toMatch(new RegExp(`/teams/${seatsTeam}/plan\\?checkout=done$`));
		const plan = (await admin.call('GET', `/teams/${seatsTeam}/plan`)).body;
		expect(plan.plan.code).toBe('team');
		expect(plan.subscription).toMatchObject({ status: 'active', seats: 5 });
		expect(plan.usage.assistantCost.limitUsdMicros).toBe(5 * 15_000_000);
		const [row] = await asOwner('SELECT seats FROM subscription WHERE billing_account_id = $1', [plan.account.id]);
		expect(row).toEqual({ seats: 5 });

		// The portal's cancel keeps the 5 seats.
		const portal = await admin.call('POST', `/teams/${seatsTeam}/plan/portal`);
		expect((await formPost(`${local(portal.body.url)}&action=cancel`)).status).toBe(303);
		expect((await admin.call('GET', `/teams/${seatsTeam}/plan`)).body.subscription).toMatchObject({ seats: 5, cancelAtPeriodEnd: true });
	});

	it('a token for one account can’t be turned to another: a changed payload is 404', async () => {
		const start = await stranger.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' });
		const t = new URL(start.body.url).searchParams.get('t')!;
		const [payload, mac] = t.split('.') as [string, string];
		const other = JSON.parse(Buffer.from(payload, 'base64url').toString());
		other.accountId = crypto.randomUUID();
		const forged = `${Buffer.from(JSON.stringify(other)).toString('base64url')}.${mac}`;
		expect((await formPost(`/billing/mock/checkout?t=${encodeURIComponent(forged)}&outcome=pays`)).status).toBe(404);
		expect((await stranger.call('GET', '/account/plan')).body.subscription).toBeNull();
	});
});

describe('328: the account’s provider customer', () => {
	const ref = (u: User, account: string) => withUser(u.id, async (db) => (await db.query('SELECT app_billing_customer_ref($1) AS r', [account])).rows[0].r);
	const set = (u: User, account: string, value: string) =>
		withUser(u.id, async (db) => (await db.query('SELECT app_billing_set_customer_ref($1, $2) AS r', [account, value])).rows[0].r);

	it('the first stored customer wins; only the account’s person (or a team admin) reads or writes it', async () => {
		const account = (await member.call('GET', '/account/plan')).body.account.id as string;
		expect(await ref(member, account)).toBeNull();
		// A stranger can't write or read it (and the positive control below can).
		expect(await set(stranger, account, cus('Stranger1'))).toBeNull();
		expect(await set(member, account, cus('First1'))).toBe(cus('First1'));
		expect(await set(member, account, cus('Second1'))).toBe(cus('First1'));
		expect(await ref(member, account)).toBe(cus('First1'));
		expect(await ref(stranger, account)).toBeNull();
		// A team's: its admin, not a member.
		const teamAccount = (await admin.call('GET', `/teams/${teamId}/plan`)).body.account.id as string;
		expect(await set(member, teamAccount, cus('Member1'))).toBeNull();
		expect(await set(admin, teamAccount, cus('Team1'))).toBe(cus('Team1'));
		expect(await ref(admin, teamAccount)).toBe(cus('Team1'));
	});

	it('refuses a malformed id, another account’s customer, and any direct write as water_app', async () => {
		const account = (await viewer.call('GET', '/account/plan')).body.account.id as string;
		expect(await sqlState(set(viewer, account, 'not-a-customer'))).toBe('23514');
		expect(await sqlState(set(viewer, account, cus('First1')))).toBe('23505');
		expect(await sqlState(withUser(viewer.id, (db) => db.query('UPDATE billing_account SET external_customer_ref = $1 WHERE id = $2', [cus('Direct1'), account])))).toBe('42501');
	});
});
