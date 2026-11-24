// Free's verified-email gate (343_free_email_gate, billing/emailGate.ts; issue #641 § Free tier and abuse):
//  - off (BILLING_ENFORCED unset, the default) an unverified or disposable-domain person on Free chats and switches
//    feeds on as before;
//  - on, on a project whose account is on Free, an assistant turn and a feed switched on (attached enabled, or patched
//    from off to on) are refused 403 email_unverified (unverified) or email_disposable (a disposable domain), before
//    anything is counted;
//  - a verified person with an ordinary address is allowed (positive control), and so is anyone on a paid account;
//  - attaching a feed switched off, and saving one already on, are never refused;
//  - app_free_email_gate answers a non-member NULL, and only ever the caller's own address.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, asOwner, disableFeedsAfterFile, retirePendingJobs, signUp } from '../__tests__/helpers.js';
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
