// 403_over_seats_and_move_pause (issue #926; docs/billing.md § Team seats, § Pausing after a downgrade):
//  - a seat cut made outside our route (Stripe's customer portal, replayed here as the mock provider's signed
//    customer.subscription.updated through the real webhook route) below the editors in use is recorded on the account,
//    the plan page says so (team.overSeats), the seat guard refuses a new editor (enforced), and the marker clears at
//    the tick once editors are made viewers (positive control: within its seats there is none);
//  - a seat cut and an editor add are ordered by one lock, either way round: the add first is counted by the cut
//    (recorded over), the cut first makes the add's guard refuse;
//  - a paused catchment moving to another account loses its pause, and its old account its grace, in the move's own
//    transaction (no tick between).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, disableFeedsAfterFile, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { seatsChangedEvent, signedDelivery } from './provider/mock.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
type User = Awaited<ReturnType<typeof signUp>>;

const local = (url: string) => {
	const u = new URL(url);
	return `${u.pathname}${u.search}`;
};
const formPost = (path: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const tick = () => runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
const overSince = async (account: string) =>
	((await asOwner('SELECT over_seats_since AS t FROM billing_account WHERE id = $1', [account])) as { t: Date | null }[])[0]!.t;
const ownerClient = async () => {
	const c = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await c.connect();
	return c;
};
/** Waits until some transaction waits on an advisory lock: the real signal that the second one is queued behind the first. */
async function someoneWaits() {
	for (let i = 0; i < 200; i++) {
		const [r] = (await asOwner(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)) as { n: number }[];
		if (r!.n > 0) return;
		await new Promise((res) => setImmediate(res));
	}
	throw new Error('no transaction waited on the lock');
}

disableFeedsAfterFile();
const made: string[] = [];
afterAll(async () => {
	vi.unstubAllEnvs();
	delete process.env.BILLING_ENFORCED;
	await retirePendingJobs(...made);
});

describe('403: a team over its paid seats', () => {
	let admin: User;
	let members: User[];
	let teamId: string;
	let account: string;
	let sub: { planCode: string; status: string; periodStart: string; periodEnd: string; cancelAtPeriodEnd: boolean };

	beforeAll(async () => {
		vi.stubEnv('BILLING_PROVIDER', 'mock');
		vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
		admin = await signUp('OsAdmin');
		members = await Promise.all(['OsM1', 'OsM2', 'OsM3', 'OsM4', 'OsM5'].map((n) => signUp(n)));
		teamId = (await admin.call('POST', '/teams', { name: `Over seats ${crypto.randomUUID().slice(0, 8)}` })).body.team.id;
		const start = await admin.call('POST', `/teams/${teamId}/plan/checkout`, { plan: 'team', interval: 'month' });
		expect(start.status).toBe(200);
		expect((await formPost(`${local(start.body.url)}&outcome=pays`)).status).toBe(303);
		expect((await admin.call('POST', `/teams/${teamId}/plan/seats`, { seats: 5 })).status).toBe(200);
		// Five editors: the admin and four members.
		for (const m of members.slice(0, 4)) expect((await admin.call('POST', `/teams/${teamId}/members`, { email: m.email, role: 'member' })).status).toBe(201);
		const plan = (await admin.call('GET', `/teams/${teamId}/plan`)).body;
		account = plan.account.id;
		sub = { planCode: 'team', status: plan.subscription.status, periodStart: plan.subscription.periodStart, periodEnd: plan.subscription.periodEnd, cancelAtPeriodEnd: false };
		expect(plan.team).toMatchObject({ editorCount: 5, overSeats: null });
		expect(await overSince(account)).toBeNull();
	}, 120_000);

	it('a portal cut to 3 seats is recorded, shown on the plan page and refuses a new editor; it clears once editors are viewers', async () => {
		const { body, signature } = signedDelivery(SECRET, seatsChangedEvent(account, sub, 3, 3));
		const res = await app.request('/billing/webhook/mock', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body });
		expect(res.status).toBe(200);
		expect(await overSince(account)).not.toBeNull();
		const plan = (await admin.call('GET', `/teams/${teamId}/plan`)).body;
		expect(plan.subscription.seats).toBe(3);
		expect(plan.team.overSeats).toMatchObject({ seats: 3, editors: 5 });
		expect(Date.parse(plan.team.overSeats.since)).not.toBeNaN();

		process.env.BILLING_ENFORCED = 'true';
		try {
			// The invite is sent; accepting it is refused (the helper accepts as the invitee).
			await expect(admin.call('POST', `/teams/${teamId}/members`, { email: members[4]!.email, role: 'member' })).rejects.toThrow(
				/402 .*"code":"plan_limit","params":\{"limit":3,"used":6,"plan":"team"\}/
			);
		} finally {
			delete process.env.BILLING_ENFORCED;
		}

		// Two members made viewers: back within 3 seats. The plan page says so at once, the tick clears the record.
		for (const m of members.slice(2, 4)) await asOwner(`UPDATE team_member SET role = 'viewer' WHERE team_id = $1 AND user_id = $2`, [teamId, m.id]);
		expect((await admin.call('GET', `/teams/${teamId}/plan`)).body.team).toMatchObject({ editorCount: 3, overSeats: null });
		await tick();
		expect(await overSince(account)).toBeNull();
	});

	it('an editor add committed first is counted by a seat cut waiting on the same lock: the team is recorded over', async () => {
		await asOwner(`UPDATE subscription SET seats = 5 WHERE billing_account_id = $1 AND status = 'active'`, [account]);
		const add = await ownerClient();
		const cut = await ownerClient();
		try {
			await add.query('BEGIN');
			await add.query(`SELECT set_config('app.billing_enforced', 'on', true)`);
			await add.query(`UPDATE team_member SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [teamId, members[2]!.id]);
			await cut.query('BEGIN');
			const cutting = cut.query(`UPDATE subscription SET seats = 3 WHERE billing_account_id = $1 AND status = 'active'`, [account]);
			await someoneWaits();
			await add.query('COMMIT');
			await cutting;
			await cut.query('COMMIT');
		} finally {
			await add.end();
			await cut.end();
		}
		expect(await overSince(account)).not.toBeNull();
		await asOwner(`UPDATE team_member SET role = 'viewer' WHERE team_id = $1 AND user_id = $2`, [teamId, members[2]!.id]);
		await tick();
		expect(await overSince(account)).toBeNull();
	});

	it('a seat cut committed first is read by an editor add waiting on the same lock: the add is refused', async () => {
		await asOwner(`UPDATE subscription SET seats = 4 WHERE billing_account_id = $1 AND status = 'active'`, [account]);
		const add = await ownerClient();
		const cut = await ownerClient();
		let refused: unknown = null;
		try {
			await cut.query('BEGIN');
			await cut.query(`UPDATE subscription SET seats = 3 WHERE billing_account_id = $1 AND status = 'active'`, [account]);
			await add.query('BEGIN');
			await add.query(`SELECT set_config('app.billing_enforced', 'on', true)`);
			const adding = add.query(`UPDATE team_member SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [teamId, members[2]!.id]).catch((e) => (refused = e));
			await someoneWaits();
			await cut.query('COMMIT');
			await adding;
			await add.query('ROLLBACK');
		} finally {
			await add.end();
			await cut.end();
		}
		expect(refused).toMatchObject({ code: '23514', constraint: 'plan_limit' });
		// Within its seats: nothing recorded.
		expect(await overSince(account)).toBeNull();
	});
});

describe('403: a paused catchment moving accounts re-syncs both at once', () => {
	it('the moved catchment loses its pause and the old account its grace, with no tick between', async () => {
		const owner = await signUp('MovePauseOwner');
		const alertBody = { rules: [{ kind: 'ewr_forecast_fail', threshold: 5, enabled: true }] };
		const pids: string[] = [];
		for (const name of ['Move A', 'Move B']) {
			const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
			pids.push(id);
			made.push(id);
		}
		const [a, b] = pids as [string, string];
		const account = ((await asOwner('SELECT billing_account_id AS id FROM project WHERE id = $1', [a])) as { id: string }[])[0]!.id;
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'mock')`, [account]);
		for (const p of pids) expect((await owner.call('PUT', `/projects/${p}/alert-rules`, alertBody)).status).toBe(200);
		await asOwner(`UPDATE project SET updated_at = now() - interval '1 day' WHERE id = $1`, [a]);
		await asOwner(`UPDATE subscription SET status = 'canceled' WHERE billing_account_id = $1`, [account]);
		await asOwner(`UPDATE billing_account SET over_free_since = now() - interval '15 days' WHERE id = $1`, [account]);
		process.env.BILLING_ENFORCED = 'true';
		try {
			await tick();
			expect((await asOwner('SELECT project_id FROM project_plan_pause WHERE project_id = ANY($1::uuid[])', [pids])).map((r) => r.project_id)).toEqual([a]);

			// The owner takes A into a new (Free) team: one statement, no tick.
			const teamId = (await owner.call('POST', '/teams', { name: `Move pause ${crypto.randomUUID().slice(0, 8)}` })).body.team.id as string;
			const moved = await owner.call('PATCH', `/projects/${a}`, { teamId });
			expect(moved.status, JSON.stringify(moved.body)).toBe(200);
			expect(await asOwner('SELECT project_id FROM project_plan_pause WHERE project_id = ANY($1::uuid[])', [pids])).toEqual([]);
			const [row] = (await asOwner('SELECT over_free_since FROM billing_account WHERE id = $1', [account])) as { over_free_since: Date | null }[];
			expect(row!.over_free_since).toBeNull();
			// Positive control: B, still the person's, stays live and unpaused, and their account is within Free.
			expect((await owner.call('GET', `/projects/${b}`)).body.project.planPausedAt).toBeNull();
		} finally {
			delete process.env.BILLING_ENFORCED;
		}
	});
});
