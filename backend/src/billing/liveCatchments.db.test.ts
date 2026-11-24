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
// 340_live_catchment_gaps: a copy or an import at the limit starts with automatic runs off (never refused) and says so;
// a live catchment moving to another billing account is checked against that account's limit; the Plan page counts them.
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

	it('on: a new project created with automatic runs on (a copy, an import) is never refused, and starts with them off (340)', async () => {
		const create = async (on: boolean) => {
			const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
			await client.connect();
			try {
				await client.query('BEGIN');
				if (on) await client.query(`SELECT set_config('app.billing_enforced', 'on', true)`);
				const { rows } = await client.query<{ on: string | null }>(
					`INSERT INTO project (name, created_by, settings) VALUES ('Live C', $1, '{"autoRun": {"enabled": true, "debounceMinutes": 5}}')
					 RETURNING settings -> 'autoRun' ->> 'enabled' AS on`,
					[owner.id]
				);
				return rows[0]!.on;
			} finally {
				await client.query('ROLLBACK');
				await client.end();
			}
		};
		// A is live, so the account is at its one: on, the new project starts with automatic runs off (its other fields kept).
		expect(await create(true)).toBe('false');
		// Off, as stored.
		expect(await create(false)).toBe('true');
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

describe('340: what 338 left (copy, import, a move to another account, the Plan page)', () => {
	const autoOn = async (pid: string) =>
		((await asOwner(`SELECT settings -> 'autoRun' ->> 'enabled' AS on FROM project WHERE id = $1`, [pid])) as { on: string | null }[])[0]!.on === 'true';
	const exportDoc = async (u: User, pid: string) => {
		const res = await u.call('GET', `/projects/${pid}/export.json`);
		expect(res.status).toBe(200);
		return res.body;
	};

	it('on, at the limit: a copy or an import of a catchment with automatic runs on starts with them off and says so; nothing is refused', async () => {
		const u = await signUp('LiveCopy');
		const x = await newProject(u, 'Copy X');
		expect((await u.call('PATCH', `/projects/${x}`, { settings: { autoRun: { enabled: true } } })).status).toBe(200);
		const account = await accountOf(x);
		enforce();
		const copy = await u.call('POST', `/projects/${x}/copy`, { name: 'Copy X2' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		made.push(copy.body.project.id);
		expect(copy.body.autoRunsOff).toBe('live_catchments');
		expect(copy.body.project.settings.autoRun.enabled).toBe(false);
		expect(await autoOn(copy.body.project.id)).toBe(false);
		const doc = await exportDoc(u, x);
		const imp = await u.call('POST', '/projects/import', doc);
		expect(imp.status, JSON.stringify(imp.body)).toBe(201);
		made.push(imp.body.project.id);
		expect(imp.body.autoRunsOff).toBe('live_catchments');
		expect(await autoOn(imp.body.project.id)).toBe(false);
		// Still one live catchment, the original, untouched.
		expect(await liveCount(account)).toBe(1);
		expect(await autoOn(x)).toBe(true);
	});

	it('positive controls: below the limit, or with enforcement off, the copy keeps automatic runs on and says nothing', async () => {
		const u = await signUp('LiveCopyFree');
		const x = await newProject(u, 'Below X');
		expect((await u.call('PATCH', `/projects/${x}`, { settings: { autoRun: { enabled: true } } })).status).toBe(200);
		// Off: the copy keeps them on (two live).
		const off = await u.call('POST', `/projects/${x}/copy`, { name: 'Below X2' });
		expect(off.status).toBe(201);
		made.push(off.body.project.id);
		expect(off.body.autoRunsOff).toBeUndefined();
		expect(await autoOn(off.body.project.id)).toBe(true);
		// On, below the limit (a fresh account's first catchment): the import keeps them on.
		const v = await signUp('LiveImportFirst');
		enforce();
		const imp = await v.call('POST', '/projects/import', await exportDoc(u, x));
		expect(imp.status, JSON.stringify(imp.body)).toBe(201);
		made.push(imp.body.project.id);
		expect(imp.body.autoRunsOff).toBeUndefined();
		expect(await autoOn(imp.body.project.id)).toBe(true);
	});

	it('a live catchment moving into a Free team that has its live one is refused on; a catchment that isn’t live moves; off, both move', async () => {
		const u = await signUp('LiveMove');
		const teamId = (await u.call('POST', '/teams', { name: 'Live move WUA' })).body.team.id as string;
		const t = (await u.call('POST', '/projects', { name: 'Team live', teamId })).body.project.id as string;
		made.push(t);
		expect((await u.call('PUT', `/projects/${t}/alert-rules`, alertBody)).status).toBe(200);
		const [x, quiet] = [await newProject(u, 'Move X'), await newProject(u, 'Move quiet')];
		expect((await u.call('PUT', `/projects/${x}/alert-rules`, alertBody)).status).toBe(200);
		enforce();
		const moved = await u.call('PATCH', `/projects/${x}`, { teamId });
		expect(moved.status).toBe(402);
		expect(moved.body).toMatchObject({ code: 'plan_limit', params: { limit: 1, used: 2, plan: 'free', key: 'live_catchments' } });
		expect(await accountOf(x)).not.toBe(await accountOf(t));
		// Positive control: a catchment that isn't live moves.
		expect((await u.call('PATCH', `/projects/${quiet}`, { teamId })).status).toBe(200);
		// Off, the live one moves too.
		delete process.env.BILLING_ENFORCED;
		expect((await u.call('PATCH', `/projects/${x}`, { teamId })).status).toBe(200);
		expect(await liveCount(await accountOf(t))).toBe(2);
	});

	it('the Plan page’s usage counts live catchments against the plan’s limit', async () => {
		const u = await signUp('LivePlan');
		const x = await newProject(u, 'Plan X');
		await newProject(u, 'Plan Y');
		expect((await u.call('GET', '/account/plan')).body.usage.liveCatchments).toEqual({ used: 0, limit: 1 });
		expect((await u.call('PUT', `/projects/${x}/alert-rules`, alertBody)).status).toBe(200);
		expect((await u.call('GET', '/account/plan')).body.usage.liveCatchments).toEqual({ used: 1, limit: 1 });
	});

	it('the app role can’t call the new trigger functions', async () => {
		const u = await signUp('LiveFn');
		for (const fn of ['project_live_start_off', 'project_move_live_guard']) {
			const { rows } = await withUser(u.id, (db) => db.query<{ ok: boolean }>(`SELECT has_function_privilege('water_app', $1 || '()', 'EXECUTE') AS ok`, [fn]));
			expect(rows[0]!.ok, fn).toBe(false);
		}
	});
});
