// Changing a Team's seats against Postgres (issue #641 Phase 5, docs/billing.md
// § Changing a Team's seats): a mock Team bought at the 3 included seats and
// changed to 5 ends with seats 5, written by app_billing_apply through the real
// webhook route (the route writes none itself); back to 3 again; only the
// team's admins may (404 to a member and a stranger, with the admin as the
// positive control); and 333's app_billing_live_subscription_ref answers only
// them.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
type User = Awaited<ReturnType<typeof signUp>>;

let admin: User;
let member: User;
let stranger: User;
let teamId: string;

const local = (url: string) => {
	const u = new URL(url);
	return `${u.pathname}${u.search}`;
};
const formPost = (path: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });

beforeAll(async () => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
	[admin, member, stranger] = (await Promise.all(['SeAdmin', 'SeMember', 'SeStranger'].map((n) => signUp(n)))) as [User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: `Seats WUA ${crypto.randomUUID().slice(0, 8)}` })).body.team.id;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
}, 120_000);

afterAll(() => {
	vi.unstubAllEnvs();
});

describe('POST /teams/:id/plan/seats with the mock provider', () => {
	it('is 409 before the team subscribes', async () => {
		expect((await admin.call('POST', `/teams/${teamId}/plan/seats`, { seats: 5 })).status).toBe(409);
	});

	it('a Team at the 3 included seats changed to 5 ends with seats 5 through the webhook, and back to 3', async () => {
		const start = await admin.call('POST', `/teams/${teamId}/plan/checkout`, { plan: 'team', interval: 'month' });
		expect(start.status).toBe(200);
		expect((await formPost(`${local(start.body.url)}&outcome=pays`)).status).toBe(303);
		const before = (await admin.call('GET', `/teams/${teamId}/plan`)).body;
		expect(before.subscription).toMatchObject({ status: 'active', seats: 3 });
		const accountId = before.account.id as string;

		// Only the team's admins: a member and a stranger meet 404, and nothing changes.
		for (const u of [member, stranger]) expect((await u.call('POST', `/teams/${teamId}/plan/seats`, { seats: 5 })).status, u.email).toBe(404);
		expect((await admin.call('POST', `/teams/${teamId}/plan/seats`, { seats: 3 })).status).toBe(400);
		expect((await admin.call('POST', `/teams/${teamId}/plan/seats`, { seats: 2 })).status).toBe(400);

		const res = await admin.call('POST', `/teams/${teamId}/plan/seats`, { seats: 5 });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ seats: 5 });
		const after = (await admin.call('GET', `/teams/${teamId}/plan`)).body;
		expect(after.subscription).toMatchObject({ status: 'active', seats: 5, periodStart: before.subscription.periodStart, periodEnd: before.subscription.periodEnd });
		expect(after.usage.assistantCost.limitUsdMicros).toBe(5 * 15_000_000);
		const events = await asOwner(`SELECT type, outcome FROM billing_event WHERE account_id = $1 AND type = 'subscription.updated' ORDER BY received_at`, [accountId]);
		expect(events).toHaveLength(2);

		expect((await admin.call('POST', `/teams/${teamId}/plan/seats`, { seats: 3 })).status).toBe(200);
		expect((await admin.call('GET', `/teams/${teamId}/plan`)).body.subscription).toMatchObject({ seats: 3 });
	});
});

describe('333: app_billing_live_subscription_ref', () => {
	const ref = (u: User, account: string) => withUser(u.id, async (db) => (await db.query('SELECT app_billing_live_subscription_ref($1) AS r', [account])).rows[0].r);

	it('answers the provider and id to the team’s admin (positive control), null to a member and a stranger', async () => {
		const account = (await admin.call('GET', `/teams/${teamId}/plan`)).body.account.id as string;
		expect(await ref(admin, account)).toEqual({ provider: 'mock', externalRef: `sub_mock_${account.replace(/-/g, '')}` });
		expect(await ref(member, account)).toBeNull();
		expect(await ref(stranger, account)).toBeNull();
	});

	it('is null for an account with no live subscription', async () => {
		const own = (await stranger.call('GET', '/account/plan')).body.account.id as string;
		expect(await ref(stranger, own)).toBeNull();
	});
});
