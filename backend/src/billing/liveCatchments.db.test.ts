// 338_live_catchments (issue #641): Free's one live catchment, refused through the routes that switch operations on.
//  - off (BILLING_ENFORCED unset, the default) a Free account switches feeds, alerts and automatic runs on in as many
//    catchments as it likes;
//  - on, the first operational feature in a second catchment is refused 402 plan_limit
//    ({ limit: 1, used: 2, plan: 'free', key: 'live_catchments' }), through each route that switches one on (a data
//    feed, an alert rule, automatic runs) and through a publication (SQL);
//  - the catchment already live takes more (positive control), and nothing already on is switched off;
//  - switching the live catchment's features off frees the slot: the owner picks the live catchment;
//  - a Pro account (live_catchments null) is never refused;
//  - the app role can't call the counting functions;
//  - two parallel switches on two catchments: exactly one wins.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, disableFeedsAfterFile, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { cellCentre } from '../feeds/cellCache.js';
import { withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

const feedBody = { source: 'chirps', config: { cells: [{ ...cellCentre({ row: 1600, col: 4100 }), weight: 1 }], startDate: '2024-01-01' } };
const alertBody = { rules: [{ kind: 'ewr_forecast_fail', threshold: 5, enabled: true }] };
const alertOff = { rules: [{ kind: 'ewr_forecast_fail', threshold: 5, enabled: false }] };

const made: string[] = [];
const newProject = async (u: User, name: string) => {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	made.push(id);
	return id;
};
const accountOf = async (pid: string) =>
	((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid])) as { a: string }[])[0]!.a;
const liveCount = async (account: string) =>
	Number(((await asOwner('SELECT app_live_catchments_in_use($1) AS n', [account])) as { n: string }[])[0]!.n);
/** A transaction as the schema owner, billing enforced or not (as db/tx.ts sets it), rolled back when `rollback`; its refusal or null. */
async function inTx(sql: string, params: unknown[], on: boolean, rollback: boolean): Promise<string | null> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		if (on) await client.query(`SELECT set_config('app.billing_enforced', 'on', true)`);
		await client.query(sql, params);
		await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
		return null;
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		const e = err as { code?: string; constraint?: string };
		return `${e.code}/${e.constraint}`;
	} finally {
		await client.end();
	}
}
const enforce = () => {
	process.env.BILLING_ENFORCED = 'true';
};

disableFeedsAfterFile();

afterEach(() => {
	delete process.env.BILLING_ENFORCED;
});

afterAll(() => retirePendingJobs(...made));

describe('338: Free’s one live catchment', () => {
	let owner: User;
	let a: string;
	let b: string;
	let account: string;

	beforeAll(async () => {
		owner = await signUp('LiveFree');
		[a, b] = [await newProject(owner, 'Live A'), await newProject(owner, 'Live B')];
		account = await accountOf(a);
	});

	it('off: two catchments go live, and the count says so', async () => {
		const off = await signUp('LiveOff');
		const [x, y] = [await newProject(off, 'Off X'), await newProject(off, 'Off Y')];
		expect((await off.call('PUT', `/projects/${x}/alert-rules`, alertBody)).status).toBe(200);
		const f = await off.call('POST', `/projects/${y}/feeds`, feedBody);
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		expect(await liveCount(await accountOf(x))).toBe(2);
	});

	it('on: the first catchment goes live; more in it passes; a second is refused 402 plan_limit on every route', async () => {
		enforce();
		expect((await owner.call('PUT', `/projects/${a}/alert-rules`, alertBody)).status).toBe(200);
		// Positive control: the live catchment takes a feed and automatic runs.
		const fa = await owner.call('POST', `/projects/${a}/feeds`, feedBody);
		expect(fa.status, JSON.stringify(fa.body)).toBe(201);
		expect((await owner.call('PATCH', `/projects/${a}`, { settings: { autoRun: { enabled: true } } })).status).toBe(200);
		expect(await liveCount(account)).toBe(1);

		const want = { code: 'plan_limit', params: { limit: 1, used: 2, plan: 'free', key: 'live_catchments' } };
		const feed = await owner.call('POST', `/projects/${b}/feeds`, feedBody);
		expect(feed.status).toBe(402);
		expect(feed.body).toMatchObject(want);
		expect(feed.body.error).not.toMatch(/quota|402|violat/i);
		const alert = await owner.call('PUT', `/projects/${b}/alert-rules`, alertBody);
		expect(alert.status).toBe(402);
		expect(alert.body).toMatchObject(want);
		const auto = await owner.call('PATCH', `/projects/${b}`, { settings: { autoRun: { enabled: true } } });
		expect(auto.status).toBe(402);
		expect(auto.body).toMatchObject(want);
		// Nothing was written in B, and A is untouched.
		expect(await liveCount(account)).toBe(1);
		expect(((await asOwner('SELECT count(*)::int AS n FROM data_feed WHERE project_id = $1', [b])) as { n: number }[])[0]!.n).toBe(0);
	});

	it('on: a publication in a second catchment is refused (SQL, plan_limit); off, the same insert passes', async () => {
		const run = ((await asOwner(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, 'x', '2020-01-01', '2020-02-29', '{}') RETURNING id::text`,
			[b, owner.id]
		)) as { id: string }[])[0]!.id;
		const publish = (on: boolean) => inTx(`INSERT INTO run_publication (project_id, run_id) VALUES ($1, $2)`, [b, run], on, true);
		expect(await publish(true)).toBe('23514/plan_limit');
		expect(await publish(false)).toBeNull();
	});

	it('on: a new project created with automatic runs on (a copy, an import) is never refused: Free doesn’t ration copying', async () => {
		const create = (on: boolean) =>
			inTx(`INSERT INTO project (name, created_by, settings) VALUES ('Live C', $1, '{"autoRun": {"enabled": true}}')`, [owner.id], on, true);
		expect(await create(true)).toBeNull();
	});

	it('on: switching A off frees the slot, so B can go live (the owner picks)', async () => {
		enforce();
		const feeds = (await owner.call('GET', `/projects/${a}/feeds`)).body.feeds as { id: string }[];
		for (const f of feeds) expect((await owner.call('PATCH', `/projects/${a}/feeds/${f.id}`, { enabled: false })).status).toBe(200);
		expect((await owner.call('PUT', `/projects/${a}/alert-rules`, alertOff)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${a}`, { settings: { autoRun: { enabled: false } } })).status).toBe(200);
		expect(await liveCount(account)).toBe(0);
		expect((await owner.call('PUT', `/projects/${b}/alert-rules`, alertBody)).status).toBe(200);
		expect(await liveCount(account)).toBe(1);
		// And now A is the one refused.
		expect((await owner.call('PUT', `/projects/${a}/alert-rules`, alertBody)).status).toBe(402);
	});

	it('never switches off what is already on: an account past its limit keeps both, and each takes more', async () => {
		const past = await signUp('LivePast');
		const [x, y] = [await newProject(past, 'Past X'), await newProject(past, 'Past Y')];
		expect((await past.call('PUT', `/projects/${x}/alert-rules`, alertBody)).status).toBe(200);
		expect((await past.call('PUT', `/projects/${y}/alert-rules`, alertBody)).status).toBe(200);
		enforce();
		expect(await liveCount(await accountOf(x))).toBe(2);
		expect((await past.call('PATCH', `/projects/${y}`, { settings: { autoRun: { enabled: true } } })).status).toBe(200);
		const z = await newProject(past, 'Past Z');
		expect((await past.call('PUT', `/projects/${z}/alert-rules`, alertBody)).status).toBe(402);
	});

	it('a Pro account is never refused', async () => {
		const pro = await signUp('LivePro');
		const [x, y] = [await newProject(pro, 'Pro X'), await newProject(pro, 'Pro Y')];
		const proAccount = await accountOf(x);
		await withoutUser(async (db) =>
			db.query('SELECT app_billing_apply($1, $2, $3, $4::jsonb)', [
				'mock',
				`evt_${randomUUID()}`,
				'subscription.created',
				JSON.stringify({
					accountId: proAccount,
					planCode: 'pro',
					status: 'active',
					seats: 1,
					periodStart: '2026-11-01T00:00:00Z',
					periodEnd: '2026-12-01T00:00:00Z',
					trialEnd: null,
					cancelAtPeriodEnd: false,
					externalRef: `sub_live_${randomUUID()}`
				})
			])
		);
		enforce();
		expect((await pro.call('PUT', `/projects/${x}/alert-rules`, alertBody)).status).toBe(200);
		expect((await pro.call('PUT', `/projects/${y}/alert-rules`, alertBody)).status).toBe(200);
		expect(await liveCount(proAccount)).toBe(2);
		await asOwner('DELETE FROM subscription WHERE billing_account_id = $1', [proAccount]);
		await asOwner('DELETE FROM billing_event WHERE account_id = $1', [proAccount]);
	});

	it('the app role can’t call the counting functions or the guard', async () => {
		for (const sql of ['SELECT app_live_catchments_in_use($1)', 'SELECT app_live_catchment_guard($1)']) {
			await expect(withUser(owner.id, (db) => db.query(sql, [sql.includes('guard') ? a : account]))).rejects.toMatchObject({ code: '42501' });
		}
	});

	it('two parallel switches on two catchments: exactly one wins', async () => {
		const race = await signUp('LiveRace');
		const [x, y] = [await newProject(race, 'Race X'), await newProject(race, 'Race Y')];
		enforce();
		const got = await Promise.all([x, y].map((p) => race.call('PUT', `/projects/${p}/alert-rules`, alertBody)));
		expect(got.map((r) => r.status).sort()).toEqual([200, 402]);
		expect(await liveCount(await accountOf(x))).toBe(1);
	});
});
