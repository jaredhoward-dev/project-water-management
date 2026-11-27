// 341_plan_pause (issue #641 § Downgrade or lapse): after a paid plan ends, the live catchments past Free's one are
// paused after a 14-day grace, only when billing is enforced, and resumed on an upgrade. Nothing is deleted.
//  - a lapse records when the account went over Free's limit; nothing is paused during the grace;
//  - past the grace with enforcement off, nothing is paused and the grace is cleared (409);
//  - past the grace, enforced, the tick pauses every live catchment but one (the most recently active, or the one the
//    owner chose), and the paused ones' feeds, automatic runs and alert checks stop while their settings stay on
//    (positive control: the kept one still schedules all three);
//  - Fetch now on a paused catchment is refused (plan_paused), as the scheduler passes it by;
//  - the owner's choice moves the pause at once; a stranger can't choose;
//  - an upgrade resumes everything; members read the pause, strangers don't (positive control);
//  - the app role can't run the sweep outside the worker;
//  - the owner's choice racing a sync on the same account waits for it rather than deadlocking (334's lock order);
//  - 409: a plan ending in shadow mode starts no grace (and a shadow tick clears one); once enforced, the grace starts
//    then, with its email, and nothing pauses for 14 days (positive control: past them, enforced, the pause lands);
//  - the schema owner's connections (scripts, owner actions) carry the enforced setting (setOwnerBillingEnforced), so
//    their subscription writes don't drop a paused account's markers (control: a bare owner connection does, and the
//    tick puts them back); an owner action's grant resumes, and its revoke starts a new grace at once.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, disableFeedsAfterFile, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { alertsOn } from '../alerts/evaluate.js';
import { cellCentre } from '../feeds/cellCache.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { OWNER_URL } from '../__tests__/test-db.js';
import { ownerAction } from '../lambda-migrate.js';
import { setOwnerBillingEnforced } from './enforced.js';
import { enqueueForecastRun, enqueueRerun } from '../runs/autoRun.js';

type User = Awaited<ReturnType<typeof signUp>>;

const feedBody = { source: 'chirps', config: { cells: [{ ...cellCentre({ row: 1600, col: 4100 }), weight: 1 }], startDate: '2024-01-01' } };
const alertBody = { rules: [{ kind: 'ewr_forecast_fail', threshold: 5, enabled: true }] };

const made: string[] = [];
const newProject = async (u: User, name: string) => {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	made.push(id);
	return id;
};
const accountOf = async (pid: string) =>
	((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid])) as { a: string }[])[0]!.a;
const paused = async (account: string) =>
	((await asOwner('SELECT pp.project_id AS id FROM project_plan_pause pp JOIN project p ON p.id = pp.project_id WHERE p.billing_account_id = $1 ORDER BY 1', [
		account
	])) as { id: string }[]).map((r) => r.id);
const overSince = async (account: string) =>
	((await asOwner('SELECT over_free_since AS t FROM billing_account WHERE id = $1', [account])) as { t: Date | null }[])[0]!.t;
const backdateGrace = (account: string, days: number) =>
	asOwner(`UPDATE billing_account SET over_free_since = now() - make_interval(days => $2) WHERE id = $1`, [account, days]);
const tick = () => runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
const enforce = () => {
	process.env.BILLING_ENFORCED = 'true';
};
const failure = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return String((e as { code?: string }).code);
	}
};

disableFeedsAfterFile();

afterEach(() => {
	delete process.env.BILLING_ENFORCED;
});

afterAll(() => retirePendingJobs(...made));

describe('341: pausing past Free’s limit after a downgrade', () => {
	let owner: User;
	let stranger: User;
	let a: string;
	let b: string;
	let c: string;
	let account: string;

	beforeAll(async () => {
		owner = await signUp('PauseOwner');
		stranger = await signUp('PauseStranger');
		[a, b, c] = [await newProject(owner, 'Pause A'), await newProject(owner, 'Pause B'), await newProject(owner, 'Pause C')];
		account = await accountOf(a);
		// On Pro, all three go live: alerts in each, a feed and automatic runs in A and C.
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'mock')`, [account]);
		for (const p of [a, b, c]) expect((await owner.call('PUT', `/projects/${p}/alert-rules`, alertBody)).status).toBe(200);
		for (const p of [a, c]) {
			const f = await owner.call('POST', `/projects/${p}/feeds`, feedBody);
			expect(f.status, JSON.stringify(f.body)).toBe(201);
			expect((await owner.call('PATCH', `/projects/${p}`, { settings: { autoRun: { enabled: true } } })).status).toBe(200);
		}
		// C is the most recently active.
		await asOwner(`UPDATE project SET updated_at = now() - interval '1 day' WHERE id = ANY($1::uuid[])`, [[a, b]]);
		expect(await overSince(account)).toBeNull();
	});

	it('a lapse starts the grace: the time is recorded, and nothing is paused during it, enforced', async () => {
		// The schema owner's change carries no enforcement setting: no grace starts (409).
		await asOwner(`UPDATE subscription SET status = 'canceled' WHERE billing_account_id = $1 AND status = 'active'`, [account]);
		expect(await overSince(account)).toBeNull();
		enforce();
		await tick();
		expect(await overSince(account)).not.toBeNull();
		expect(await paused(account)).toEqual([]);
		await backdateGrace(account, 13);
		await tick();
		expect(await paused(account)).toEqual([]);
	});

	it('past the grace with enforcement off, nothing is paused and the grace is cleared (409)', async () => {
		await backdateGrace(account, 15);
		await tick();
		expect(await paused(account)).toEqual([]);
		expect(await overSince(account)).toBeNull();
	});

	it('past the grace, enforced: every live catchment but the most recently active is paused, and nothing is deleted', async () => {
		await backdateGrace(account, 15);
		enforce();
		const t = await tick();
		expect(t.catchmentsPaused).toBeGreaterThanOrEqual(2);
		expect(await paused(account)).toEqual([a, b].sort());
		// Nothing switched off or deleted: the rules, feeds and the setting are as they were.
		const [state] = (await asOwner(
			`SELECT (SELECT count(*)::int FROM alert_rule WHERE project_id = ANY($1::uuid[]) AND enabled) AS rules,
			        (SELECT count(*)::int FROM data_feed WHERE project_id = ANY($1::uuid[]) AND enabled) AS feeds,
			        (SELECT count(*)::int FROM project WHERE id = ANY($1::uuid[]) AND settings -> 'autoRun' ->> 'enabled' = 'true') AS auto`,
			[[a, b, c]]
		)) as { rules: number; feeds: number; auto: number }[];
		expect(state).toEqual({ rules: 3, feeds: 2, auto: 2 });
		// A second tick changes nothing.
		await tick();
		expect(await paused(account)).toEqual([a, b].sort());
	});

	it('a paused catchment’s feeds, automatic runs and alert checks stop; the kept one’s go on (positive control)', async () => {
		const due = (await withoutUser((db) => db.query<{ project_id: string }>('SELECT project_id FROM app_due_feeds(500, true, $1::uuid[])', [[a, c]]))).rows;
		expect(due.map((r) => r.project_id)).toEqual([c]);
		await withUser(owner.id, async (db) => {
			expect(await enqueueRerun(db, a, 'series')).toBeNull();
			expect(await enqueueForecastRun(db, a)).toBeNull();
			expect(await alertsOn(db, a)).toBe(false);
			expect(await enqueueRerun(db, c, 'series')).not.toBeNull();
			expect(await enqueueForecastRun(db, c)).not.toBeNull();
			expect(await alertsOn(db, c)).toBe(true);
		});
		// The scheduled alert checks: none for paused B, one for kept C, with nothing pending in either.
		await retirePendingJobs(b, c);
		const schedule = async (p: string) =>
			(await withoutUser((db) => db.query<{ n: number }>(`SELECT app_alert_schedule($1, interval '0', 10) AS n`, [p]))).rows[0]!.n;
		expect(await schedule(b)).toBe(0);
		expect(await schedule(c)).toBe(1);
	});

	it('Fetch now on a paused catchment is refused 409 plan_paused and queues nothing; on the kept one it fetches (positive control)', async () => {
		enforce();
		await retirePendingJobs(a, c);
		const feedOf = async (p: string) => ((await asOwner('SELECT id FROM data_feed WHERE project_id = $1', [p])) as { id: string }[])[0]!.id;
		const fetches = async (p: string) =>
			((await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND kind = 'feed_fetch' AND status = 'queued'`, [p])) as { n: number }[])[0]!.n;
		const refused = await owner.call('POST', `/projects/${a}/feeds/${await feedOf(a)}/run-now`);
		expect(refused.status, JSON.stringify(refused.body)).toBe(409);
		expect(refused.body.details).toEqual({ code: 'plan_paused' });
		expect(refused.body.error).not.toMatch(/quota|402|plan_limit/i);
		expect(await fetches(a)).toBe(0);
		const kept = await owner.call('POST', `/projects/${c}/feeds/${await feedOf(c)}/run-now`);
		expect([200, 202], JSON.stringify(kept.body)).toContain(kept.status);
		expect(await fetches(c)).toBe(1);
		await retirePendingJobs(c);
	});

	it('members read the pause, strangers don’t (positive control: the member)', async () => {
		const read = (u: User, p: string) =>
			withUser(u.id, async (db) => (await db.query('SELECT paused_at FROM project_plan_pause WHERE project_id = $1', [p])).rows.length);
		expect(await read(owner, a)).toBe(1);
		expect(await read(stranger, a)).toBe(0);
		expect(await withUser(owner.id, async (db) => (await db.query('SELECT app_project_plan_paused($1) AS t', [c])).rows[0].t)).toBeNull();
	});

	it('the owner chooses the kept catchment and the pause moves at once; a stranger can’t choose', async () => {
		enforce();
		expect(await failure(withUser(stranger.id, (db) => db.query('SELECT app_billing_keep_catchment($1)', [a])))).toBe('P0002');
		await withUser(owner.id, (db) => db.query('SELECT app_billing_keep_catchment($1)', [a]));
		expect(await paused(account)).toEqual([b, c].sort());
		// The next tick keeps the owner's choice over the most recent activity.
		await tick();
		expect(await paused(account)).toEqual([b, c].sort());
	});

	it('an upgrade resumes every catchment and ends the grace', async () => {
		enforce();
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'mock')`, [account]);
		expect(await paused(account)).toEqual([]);
		expect(await overSince(account)).toBeNull();
		await tick();
		expect(await paused(account)).toEqual([]);
	});

	it('an account that never had a plan is never paused, however many live catchments it has', async () => {
		const free = await signUp('PauseNeverPaid');
		const [x, y] = [await newProject(free, 'Never X'), await newProject(free, 'Never Y')];
		for (const p of [x, y]) expect((await free.call('PUT', `/projects/${p}/alert-rules`, alertBody)).status).toBe(200);
		enforce();
		await tick();
		const acct = await accountOf(x);
		expect(await overSince(acct)).toBeNull();
		expect(await paused(acct)).toEqual([]);
	});

	it('only the worker runs the sweep', async () => {
		expect(await failure(withUser(owner.id, (db) => db.query('SELECT app_plan_pause_tick()')))).toBe('42501');
		expect(await failure(withUser(owner.id, (db) => db.query('SELECT app_plan_pause_sync($1)', [account])))).toBe('42501');
	});
});

describe('341: lock order on one account', () => {
	it('keeping a catchment while a sync holds the account’s billing lock waits for it, and both finish (no 40P01)', async () => {
		const owner = await signUp('PauseRace');
		const [x, y] = [await newProject(owner, 'Race X'), await newProject(owner, 'Race Y')];
		for (const p of [x, y]) expect((await owner.call('PUT', `/projects/${p}/alert-rules`, alertBody)).status).toBe(200);
		const acct = await accountOf(x);
		// A lapsed plan with both catchments live; the grace cleared, so the next sync writes the account row again.
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'canceled', 'mock')`, [acct]);
		await asOwner('UPDATE billing_account SET over_free_since = NULL WHERE id = $1', [acct]);
		const connect = async () => {
			const c = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
			await c.connect();
			return c;
		};
		const syncer = await connect();
		const keeper = await connect();
		try {
			// The sync (the tick, a subscription change) has taken 334's lock and not yet written the row.
			await syncer.query('BEGIN');
			// Enforced, as the worker's transaction is when the grace starts (409: in shadow mode the sync writes no grace).
			await syncer.query(`SELECT set_config('app.billing_enforced', 'on', true)`);
			await syncer.query(`SELECT pg_advisory_xact_lock(hashtext('billing:' || $1::text))`, [acct]);
			const keeperPid = (await keeper.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
			await keeper.query('BEGIN');
			await keeper.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.id]);
			const keeping = keeper.query('SELECT app_billing_keep_catchment($1)', [x]).then(
				async () => (await keeper.query('COMMIT'), 'ok'),
				(e: { code?: string }) => String(e.code)
			);
			// The owner's choice waits on the account's billing lock (an advisory lock, before any write to the row).
			await expect
				.poll(async () =>
					(await syncer.query<{ w: string | null }>('SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1', [keeperPid])).rows[0]!.w
				)
				.toBe('Lock');
			// The sync goes on to write the account row (the grace starts again), and commits.
			await syncer.query('SELECT app_plan_pause_sync($1)', [acct]);
			await syncer.query('COMMIT');
			expect(await keeping).toBe('ok');
		} finally {
			await syncer.query('ROLLBACK').catch(() => {});
			await keeper.query('ROLLBACK').catch(() => {});
			await syncer.end();
			await keeper.end();
		}
		const [row] = (await asOwner('SELECT kept_project_id AS kept, over_free_since AS since FROM billing_account WHERE id = $1', [acct])) as {
			kept: string;
			since: Date | null;
		}[];
		expect(row!.kept).toBe(x);
		expect(row!.since).toBeInstanceOf(Date);
	});
});

describe('409: the grace starts when enforcement does', () => {
	it('a staff grant ending in shadow mode starts no grace; once enforced, the grace starts then, its email is queued and nothing pauses for 14 days', async () => {
		const owner = await signUp('GraceLate');
		const [x, y] = [await newProject(owner, 'Late X'), await newProject(owner, 'Late Y')];
		for (const p of [x, y]) expect((await owner.call('PUT', `/projects/${p}/alert-rules`, alertBody)).status).toBe(200);
		const acct = await accountOf(x);
		const kinds = async () =>
			((await asOwner('SELECT kind FROM billing_notice WHERE billing_account_id = $1 ORDER BY created_at, kind', [acct])) as { kind: string }[]).map((r) => r.kind);
		// A staff grant whose end has passed (330), both catchments live under it.
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider, period_end) VALUES ($1, 'pro', 'active', 'manual', now() - interval '1 minute')`, [
			acct
		]);
		// Shadow mode: the tick expires the grant and starts no grace clock.
		expect((await tick()).staffGrantsExpired).toBeGreaterThanOrEqual(1);
		expect(((await asOwner('SELECT status FROM subscription WHERE billing_account_id = $1', [acct])) as { status: string }[])[0]!.status).toBe('expired');
		expect(await overSince(acct)).toBeNull();
		// A grace stamped before 409 (or under enforcement since switched off) is cleared by a shadow tick, not kept running.
		await backdateGrace(acct, 30);
		await tick();
		expect(await overSince(acct)).toBeNull();
		expect(await paused(acct)).toEqual([]);
		expect(await kinds()).toEqual([]);

		// Enforcement switched on: the first tick starts the grace now, queues (and sends) the grace email, pauses nothing.
		enforce();
		await tick();
		const since = await overSince(acct);
		expect(since).toBeInstanceOf(Date);
		expect(Math.abs(Date.now() - since!.getTime())).toBeLessThan(60_000);
		expect(await kinds()).toEqual(['grace']);
		expect(await paused(acct)).toEqual([]);
		await backdateGrace(acct, 13);
		await tick();
		expect(await paused(acct)).toEqual([]);

		// Positive control, the enforced path: past the 14 days the catchment past Free's one pauses, and the owner is told.
		await backdateGrace(acct, 15);
		expect((await tick()).catchmentsPaused).toBeGreaterThanOrEqual(1);
		expect((await paused(acct)).length).toBe(1);
		expect(await kinds()).toContain('paused');
	});
});

describe('409: the schema owner’s subscription writes, enforced', () => {
	it('an owner write on a paused account keeps its pause; an owner grant resumes it and the revoke starts a new grace', async () => {
		const owner = await signUp('PauseOwnerPath');
		const [x, y] = [await newProject(owner, 'Owner X'), await newProject(owner, 'Owner Y')];
		// Both live before enforcement (on, Free's limit would refuse the second).
		for (const p of [x, y]) expect((await owner.call('PUT', `/projects/${p}/alert-rules`, alertBody)).status).toBe(200);
		const acct = await accountOf(x);
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'canceled', 'mock')`, [acct]);
		enforce();
		await tick();
		await backdateGrace(acct, 15);
		await tick();
		const before = await paused(acct);
		expect(before.length).toBe(1);
		const touch = `UPDATE subscription SET status = status WHERE billing_account_id = $1`;

		// The owner's connection as the scripts and owner actions open it: the sync its write fires sees enforcement on.
		const client = new pg.Client({ connectionString: OWNER_URL });
		await client.connect();
		try {
			await setOwnerBillingEnforced(client);
			await client.query(touch, [acct]);
		} finally {
			await client.end();
		}
		expect(await paused(acct)).toEqual(before);

		// Control: a bare owner connection (no setting) drops the markers until the next tick puts them back.
		await asOwner(touch, [acct]);
		expect(await paused(acct)).toEqual([]);
		await tick();
		expect(await paused(acct)).toEqual(before);

		// Through the migrate Lambda's owner actions: a grant resumes everything (a live plan) ...
		const [u] = (await asOwner('SELECT email FROM app_user WHERE id = $1', [owner.id])) as { email: string }[];
		await ownerAction({ action: 'billing-grant', email: u!.email, plan: 'pro', until: '2099-03-31', reason: 'Pilot', by: 'octocat' }, undefined, async () => OWNER_URL);
		expect(await paused(acct)).toEqual([]);
		expect(await overSince(acct)).toBeNull();
		// ... and its revoke is a lapse under enforcement: the new grace starts at once, nothing paused yet.
		await ownerAction({ action: 'billing-revoke', email: u!.email, reason: 'Pilot ended', by: 'octocat' }, undefined, async () => OWNER_URL);
		expect(await overSince(acct)).toBeInstanceOf(Date);
		expect(await paused(acct)).toEqual([]);
	});
});
