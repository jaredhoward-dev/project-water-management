// 341_plan_pause (issue #641 § Downgrade or lapse): after a paid plan ends, the live catchments past Free's one are
// paused after a 14-day grace, only when billing is enforced, and resumed on an upgrade. Nothing is deleted.
//  - a lapse records when the account went over Free's limit; nothing is paused during the grace;
//  - past the grace with enforcement off, nothing is paused;
//  - past the grace, enforced, the tick pauses every live catchment but one (the most recently active, or the one the
//    owner chose), and the paused ones' feeds, automatic runs and alert checks stop while their settings stay on
//    (positive control: the kept one still schedules all three);
//  - the owner's choice moves the pause at once; a stranger can't choose;
//  - an upgrade resumes everything; members read the pause, strangers don't (positive control);
//  - the app role can't run the sweep outside the worker.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, disableFeedsAfterFile, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { alertsOn } from '../alerts/evaluate.js';
import { cellCentre } from '../feeds/cellCache.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
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
		await asOwner(`UPDATE subscription SET status = 'canceled' WHERE billing_account_id = $1 AND status = 'active'`, [account]);
		expect(await overSince(account)).not.toBeNull();
		enforce();
		await tick();
		expect(await paused(account)).toEqual([]);
		await backdateGrace(account, 13);
		await tick();
		expect(await paused(account)).toEqual([]);
	});

	it('past the grace with enforcement off, nothing is paused', async () => {
		await backdateGrace(account, 15);
		await tick();
		expect(await paused(account)).toEqual([]);
	});

	it('past the grace, enforced: every live catchment but the most recently active is paused, and nothing is deleted', async () => {
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
