// Free's verified-email gate (343_free_email_gate, billing/emailGate.ts; issue #641 § Free tier and abuse):
//  - off (BILLING_ENFORCED unset, the default) an unverified or disposable-domain person on Free chats and switches
//    feeds on as before;
//  - on, on a project whose account is on Free, an assistant turn and a feed switched on (attached enabled, or patched
//    from off to on) are refused 403 email_unverified (unverified) or email_disposable (a disposable domain), before
//    anything is counted;
//  - a verified person with an ordinary address is allowed (positive control), and so is anyone on a paid account;
//  - attaching a feed switched off, and saving one already on, are never refused;
//  - app_free_email_gate answers a non-member NULL, and only ever the caller's own address;
//  - 348: each refusal is logged with its code and feature, never the address or its domain, and counted in
//    email_gate_refusal on today's SAST day, whatever the session's time zone (CLAUDE.md rule 7), although the route's
//    transaction rolls back; an allowed turn counts nothing; water_app can't read or write the table directly;
//  - every route that attaches a feed switched on meets the gate, not only POST /feeds: the boundary's Apply and the
//    units' Apply create enabled feeds too (createFeed holds the gate), and their refusals are counted;
//  - the count is written after the route's transaction has ended: with a pool of ONE connection (the assistant
//    Lambda's, infra/assistant.tf) a refused turn and a refused feed answer 403 at once and are still counted.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, asOwner, disableFeedsAfterFile, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { APP_URL } from '../__tests__/test-db.js';
import { closePool, getPool } from '../db/pool.js';
import { withUser } from '../db/tx.js';
import { cellCentre } from '../feeds/cellCache.js';

type User = Awaited<ReturnType<typeof signUp>>;

const made: string[] = [];
const newProject = async (u: User, name: string) => {
	const res = await u.call('POST', '/projects', { name });
	expect(res.status).toBe(201);
	const id = res.body.project.id as string;
	made.push(id);
	return id;
};
const accountOf = async (pid: string) => ((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid])) as { a: string }[])[0]!.a;
const makePaid = (account: string) =>
	asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'pro', 'active', 1, 'manual')`, [account]);
/** A verified person whose address is then moved onto a disposable domain (no email change route yet: as the owner). */
async function disposableUser(name: string): Promise<User> {
	const u = await signUp(name);
	await asOwner('UPDATE app_user SET email = $2 WHERE id = $1', [u.id, `${name.toLowerCase()}-${u.id}@mailinator.com`]);
	return u;
}

async function turn(u: User, pid: string): Promise<{ status: number; code?: string; error?: string }> {
	const res = await app.request(`/projects/${pid}/assistant/messages`, {
		method: 'POST',
		headers: { cookie: u.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
		body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
	});
	if (res.status === 200) {
		await res.text();
		return { status: 200 };
	}
	const body = (await res.json()) as { code?: string; error?: string };
	return { status: res.status, code: body.code, error: body.error };
}

const feedBody = (enabled: boolean) => ({
	source: 'chirps',
	enabled,
	config: { cells: [{ ...cellCentre({ row: 1600, col: 4100 }), weight: 1 }], startDate: '2024-01-01' }
});

const enforce = () => vi.stubEnv('BILLING_ENFORCED', 'true');

disableFeedsAfterFile();
afterEach(() => vi.unstubAllEnvs());
afterAll(() => retirePendingJobs(...made));

describe('343: the assistant needs a verified email on Free', () => {
	let unverified: User;
	let verified: User;
	let throwaway: User;
	let viewer: User;
	let pU: string;
	let pV: string;
	let pT: string;

	beforeAll(async () => {
		unverified = await signUp('GateUnverified', { verified: false });
		verified = await signUp('GateVerified');
		throwaway = await disposableUser('GateThrowaway');
		viewer = await signUp('GateViewer', { verified: false });
		pU = await newProject(unverified, 'Gate U');
		pV = await newProject(verified, 'Gate V');
		pT = await newProject(throwaway, 'Gate T');
		// An unverified viewer on a verified person's Free project: the gate is the caller's, whatever their role.
		await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'viewer')`, [pV, viewer.id]);
	});
	beforeEach(() => vi.stubEnv('ASSISTANT_PROVIDER', 'mock'));

	it('off: unverified and disposable people chat as before', async () => {
		expect((await turn(unverified, pU)).status).toBe(200);
		expect((await turn(throwaway, pT)).status).toBe(200);
	});

	it('on: an unverified person is refused 403 email_unverified, nothing reserved, no address in the error', async () => {
		enforce();
		const r = await turn(unverified, pU);
		expect(r).toMatchObject({ status: 403, code: 'email_unverified' });
		expect(r.error).toBe('Verify your email to use the assistant. We sent you a link.');
		expect(r.error).not.toContain('@');
		expect(await asOwner('SELECT 1 FROM assistant_reservation WHERE project_id = $1', [pU])).toEqual([]);
	});

	it('on: an unverified viewer is refused on a verified owner’s Free project; the owner chats (positive control)', async () => {
		enforce();
		expect(await turn(viewer, pV)).toMatchObject({ status: 403, code: 'email_unverified' });
		expect((await turn(verified, pV)).status).toBe(200);
	});

	it('on: a disposable-domain address is refused 403 email_disposable', async () => {
		enforce();
		const r = await turn(throwaway, pT);
		expect(r).toMatchObject({ status: 403, code: 'email_disposable' });
		expect(r.error).not.toMatch(/quota|abuse|402/i);
	});

	it('on: a paid account is never gated', async () => {
		const paid = await signUp('GatePaid', { verified: false });
		const p = await newProject(paid, 'Gate Paid');
		await makePaid(await accountOf(p));
		enforce();
		expect((await turn(paid, p)).status).toBe(200);
	});

	it('a non-member still gets 404, not the gate', async () => {
		enforce();
		expect((await turn(unverified, pV)).status).toBe(404);
	});
});

describe('343: switching a feed on needs a verified email on Free', () => {
	let unverified: User;
	let verified: User;
	let throwaway: User;

	beforeAll(async () => {
		unverified = await signUp('FeedUnverified', { verified: false });
		verified = await signUp('FeedVerified');
		throwaway = await disposableUser('FeedThrowaway');
	});

	it('off: an unverified person attaches a feed switched on', async () => {
		const p = await newProject(unverified, 'Feed off');
		expect((await unverified.call('POST', `/projects/${p}/feeds`, feedBody(true))).status).toBe(201);
	});

	it('on: attaching a feed switched on is refused email_unverified; attached off it is saved, and switching it on is refused', async () => {
		const p = await newProject(unverified, 'Feed on');
		enforce();
		const refused = await unverified.call('POST', `/projects/${p}/feeds`, feedBody(true));
		expect(refused.status).toBe(403);
		expect(refused.body.code).toBe('email_unverified');
		expect(refused.body.error).toBe('Verify your email to switch on a live data feed. We sent you a link.');
		expect(await asOwner('SELECT 1 FROM data_feed WHERE project_id = $1', [p])).toEqual([]);
		const saved = await unverified.call('POST', `/projects/${p}/feeds`, feedBody(false));
		expect(saved.status).toBe(201);
		const fid = saved.body.feed.id as string;
		const on = await unverified.call('PATCH', `/projects/${p}/feeds/${fid}`, { enabled: true });
		expect(on.status).toBe(403);
		expect(on.body.code).toBe('email_unverified');
		// Saving it still off is not switching it on.
		expect((await unverified.call('PATCH', `/projects/${p}/feeds/${fid}`, { targetName: 'Rain' })).status).toBe(200);
	});

	it('on: a feed already on before enforcement saves without the gate', async () => {
		const p = await newProject(unverified, 'Feed before');
		const fid = (await unverified.call('POST', `/projects/${p}/feeds`, feedBody(true))).body.feed.id as string;
		enforce();
		expect((await unverified.call('PATCH', `/projects/${p}/feeds/${fid}`, { targetName: 'Rain' })).status).toBe(200);
	});

	it('on: a disposable-domain address is refused email_disposable', async () => {
		const p = await newProject(throwaway, 'Feed throwaway');
		enforce();
		const r = await throwaway.call('POST', `/projects/${p}/feeds`, feedBody(true));
		expect(r.status).toBe(403);
		expect(r.body.code).toBe('email_disposable');
	});

	it('on: a verified person switches a feed on (positive control), and a paid account’s unverified person too', async () => {
		const p = await newProject(verified, 'Feed verified');
		const paid = await signUp('FeedPaid', { verified: false });
		const q = await newProject(paid, 'Feed paid');
		await makePaid(await accountOf(q));
		enforce();
		expect((await verified.call('POST', `/projects/${p}/feeds`, feedBody(true))).status).toBe(201);
		expect((await paid.call('POST', `/projects/${q}/feeds`, feedBody(true))).status).toBe(201);
	});
});

describe('343: every route that attaches a feed switched on meets the gate', () => {
	const ring = (w: number, s: number, e: number, n: number) => [
		[w, s],
		[e, s],
		[e, n],
		[w, n],
		[w, s]
	];
	const feedCount = async (p: string) => ((await asOwner('SELECT count(*)::int AS n FROM data_feed WHERE project_id = $1', [p])) as { n: number }[])[0]!.n;
	const refusals = async () =>
		(
			(await asOwner(
				`SELECT coalesce(sum(refusals), 0)::int AS n FROM email_gate_refusal
				 WHERE day = (now() AT TIME ZONE 'Africa/Johannesburg')::date AND code = 'email_unverified' AND feature = 'feeds'`
			)) as { n: number }[]
		)[0]!.n;
	async function withBoundary(u: User, name: string) {
		const p = await newProject(u, name);
		const r = await u.call('POST', `/projects/${p}/map/features`, {
			kind: 'catchment_boundary',
			name: 'Gate catchment',
			geometry: { type: 'Polygon', coordinates: [ring(21.21, -33.79, 21.33, -33.69)] }
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		return { p, b: r.body.feature as { id: string; updatedAt: string } };
	}
	async function withUnitParcel(u: User, name: string) {
		const p = await newProject(u, name);
		const outlet = node('Outlet', null);
		const a = node('Unit A', outlet.id);
		expect((await u.call('PUT', `/projects/${p}/model`, { nodes: [outlet, a], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const f = await u.call('POST', `/projects/${p}/map/features`, {
			kind: 'farm_parcel',
			name: 'Parcel',
			nodeId: a.id,
			geometry: { type: 'Polygon', coordinates: [ring(21.21, -33.79, 21.27, -33.74)] }
		});
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		return p;
	}

	it('on: the boundary’s Apply is refused email_unverified and counted, nothing created; a verified owner applies it (positive control)', async () => {
		const unverified = await signUp('GateBoundaryU', { verified: false });
		const verified = await signUp('GateBoundaryV');
		const u = await withBoundary(unverified, 'Gate boundary U');
		const v = await withBoundary(verified, 'Gate boundary V');
		enforce();
		const before = await refusals();
		const refused = await unverified.call('POST', `/projects/${u.p}/feeds/chirps/from-boundary`, { featureId: u.b.id, updatedAt: u.b.updatedAt });
		expect(refused.status, JSON.stringify(refused.body)).toBe(403);
		expect(refused.body.code).toBe('email_unverified');
		expect(await feedCount(u.p)).toBe(0);
		expect(await refusals()).toBe(before + 1);
		const ok = await verified.call('POST', `/projects/${v.p}/feeds/chirps/from-boundary`, { featureId: v.b.id, updatedAt: v.b.updatedAt });
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
	});

	it('off: the boundary’s Apply works for an unverified owner, as before', async () => {
		const unverified = await signUp('GateBoundaryOff', { verified: false });
		const u = await withBoundary(unverified, 'Gate boundary off');
		const r = await unverified.call('POST', `/projects/${u.p}/feeds/chirps/from-boundary`, { featureId: u.b.id, updatedAt: u.b.updatedAt });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
	});

	it('on: the units’ Apply is refused email_unverified and counted, nothing created; a verified owner applies it (positive control)', async () => {
		const unverified = await signUp('GateUnitsU', { verified: false });
		const verified = await signUp('GateUnitsV');
		const pU = await withUnitParcel(unverified, 'Gate units U');
		const pV = await withUnitParcel(verified, 'Gate units V');
		enforce();
		const before = await refusals();
		const refused = await unverified.call('POST', `/projects/${pU}/feeds/chirps/from-units`, {});
		expect(refused.status, JSON.stringify(refused.body)).toBe(403);
		expect(refused.body.code).toBe('email_unverified');
		expect(await feedCount(pU)).toBe(0);
		expect(await refusals()).toBe(before + 1);
		const ok = await verified.call('POST', `/projects/${pV}/feeds/chirps/from-units`, {});
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body.created).toBe(1);
	});
});

describe('app_free_email_gate', () => {
	it('answers the member their own address, a non-member NULL, and NULL when not enforced', async () => {
		const me = await signUp('GateFn', { verified: false });
		const other = await signUp('GateFnOther');
		const p = await newProject(me, 'Gate fn');
		const gate = (u: User) => withUser(u.id, async (db) => (await db.query('SELECT app_free_email_gate($1) AS g', [p])).rows[0]!.g);
		expect(await gate(me)).toBeNull();
		enforce();
		expect(await gate(me)).toEqual({ email: me.email, verified: false });
		expect(await gate(other)).toBeNull();
	});
});

describe('348: the gate’s refusals are logged and counted, with no address', () => {
	const today = async () =>
		((await asOwner(`SELECT to_char((now() AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS d`)) as { d: string }[])[0]!.d;
	const count = async (code: string, feature: string) =>
		(
			(await asOwner(
				`SELECT coalesce(sum(refusals), 0)::int AS n FROM email_gate_refusal
				 WHERE day = (now() AT TIME ZONE 'Africa/Johannesburg')::date AND code = $1 AND feature = $2`,
				[code, feature]
			)) as { n: number }[]
		)[0]!.n;

	beforeEach(() => vi.stubEnv('ASSISTANT_PROVIDER', 'mock'));

	it('a disposable-domain refusal is counted once and logged without the address; an allowed turn counts nothing', async () => {
		const throwaway = await disposableUser('CountThrowaway');
		const verified = await signUp('CountVerified');
		const pT = await newProject(throwaway, 'Count T');
		const pV = await newProject(verified, 'Count V');
		enforce();
		const before = await count('email_disposable', 'assistant');
		const info = vi.spyOn(console, 'info');
		try {
			expect(await turn(throwaway, pT)).toMatchObject({ status: 403, code: 'email_disposable' });
			const lines = info.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : JSON.stringify(c[0]))).filter((l) => l.includes('email_gate_refused'));
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0]!)).toEqual({ event: 'email_gate_refused', code: 'email_disposable', feature: 'assistant' });
			expect(lines[0]).not.toMatch(/@|mailinator/);
		} finally {
			info.mockRestore();
		}
		expect(await count('email_disposable', 'assistant')).toBe(before + 1);
		// Positive control the other way: a verified person's turn goes ahead and counts nothing.
		const verifiedBefore = await count('email_disposable', 'assistant');
		expect((await turn(verified, pV)).status).toBe(200);
		expect(await count('email_disposable', 'assistant')).toBe(verifiedBefore);
	});

	it('an unverified feed refusal is counted under its own code and feature', async () => {
		const u = await signUp('CountUnverified', { verified: false });
		const p = await newProject(u, 'Count feed');
		enforce();
		const before = await count('email_unverified', 'feeds');
		expect((await u.call('POST', `/projects/${p}/feeds`, feedBody(true))).status).toBe(403);
		expect(await count('email_unverified', 'feeds')).toBe(before + 1);
	});

	it('with a pool of one connection, a refusal answers 403 promptly and is counted once the route’s transaction ends', async () => {
		const throwaway = await disposableUser('CountPoolOne');
		const unverified = await signUp('CountPoolOneFeed', { verified: false });
		const pT = await newProject(throwaway, 'Count pool T');
		const pU = await newProject(unverified, 'Count pool U');
		enforce();
		const turnsBefore = await count('email_disposable', 'assistant');
		const feedsBefore = await count('email_unverified', 'feeds');
		await closePool();
		vi.stubEnv('DB_POOL_MAX', '1');
		try {
			expect(getPool().options.max).toBe(1);
			// Off Lambda the pool waits for ever for a connection (acquireTimeoutMs), so a count taken while the route
			// still held the only one would never finish: the race fails instead of hanging the file.
			const prompt = <T>(p: Promise<T>) =>
				Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waited for a second connection')), 5_000))]);
			expect(await prompt(turn(throwaway, pT))).toMatchObject({ status: 403, code: 'email_disposable' });
			expect((await prompt(unverified.call('POST', `/projects/${pU}/feeds`, feedBody(true)))).status).toBe(403);
		} finally {
			await closePool();
		}
		expect(await count('email_disposable', 'assistant')).toBe(turnsBefore + 1);
		expect(await count('email_unverified', 'feeds')).toBe(feedsBefore + 1);
	});

	it('counts on the SAST day in any session time zone; water_app may call the function but not touch the table', async () => {
		const day = await today();
		for (const tz of ['Pacific/Kiritimati', 'America/Adak']) {
			const client = new pg.Client({ connectionString: APP_URL });
			await client.connect();
			try {
				await client.query(`SET TIME ZONE '${tz}'`);
				const before = await count('email_disposable', 'feeds');
				await client.query(`SELECT app_email_gate_refused('email_disposable', 'feeds')`);
				expect(await count('email_disposable', 'feeds'), tz).toBe(before + 1);
				const direct = await client.query('SELECT count(*) FROM email_gate_refusal').then(
					() => 'ok',
					(e: { code?: string }) => e.code
				);
				expect(direct).toBe('42501');
				const bad = await client.query(`SELECT app_email_gate_refused('someone@example.com', 'feeds')`).then(
					() => 'ok',
					(e: { code?: string }) => e.code
				);
				expect(bad).toBe('23514');
			} finally {
				await client.end();
			}
		}
		const rows = (await asOwner(`SELECT to_char(max(day), 'YYYY-MM-DD') AS d FROM email_gate_refusal WHERE code = 'email_disposable' AND feature = 'feeds'`)) as { d: string }[];
		expect(rows[0]!.d).toBe(day);
	});
});
