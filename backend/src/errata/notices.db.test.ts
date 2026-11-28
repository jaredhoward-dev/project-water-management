// "A known engine bug may affect your results" notices (issue #103, the
// known-defect procedure; 153_erratum_notices.sql, errata/notices.ts,
// docs/legal/known-defect-procedure.md), at the SQL and worker level: which
// runs an erratum reaches (the run's engine, or the fit's for a `fit`
// erratum, in [first affected, fixed in)), who is queued (owners direct or
// through the team; never an editor, a viewer or an unconfirmed address),
// that a sweep runs once per range, that water_app writes nothing itself and
// only the worker sweeps, claims and purges, the email each owner gets (built
// as them, one per owner and project listing every erratum: 411), the
// re-checks at send, the data export and the purge. Each
// "can't" has its positive control.
//
// The errata here are invented (ER-9xxx, engine 90.x.y and up), so no other
// file's runs in the shared test database fall in their range.
import pg from 'pg';
import { ENGINE_ERRATA, errataFor, type Erratum } from '@water-management/engine';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withApiKey, withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { outbox } from '../mail/transport.js';
import { purgeErratumNotices, sendErratumNotices, sweepErrata } from './notices.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let teamAdmin: User;
let editor: User;
let viewer: User;
let unconfirmedOwner: User;
let otherOwner: User;
let affected: string;
let fitOnly: string;
let untouched: string;
let rowFit: string;

const erratum = (id: string, over: Partial<Erratum> = {}): Erratum => ({
	id,
	keyedOn: 'run',
	firstAffected: '90.1.0',
	fixedIn: '90.3.0',
	severity: 'High',
	appliesWhen: 'A dam <b>spills</b> on a dry day',
	summary: 'The spill was counted twice',
	source: 'engine-audit.md Z1',
	...over
});

/** Test state past the guards, as the schema owner with triggers off. */
async function arrange<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

const queued = async (erratumId: string) =>
	(await asOwner('SELECT project_id::text AS p, user_id::text AS u, run_count AS n FROM erratum_notice WHERE erratum_id = $1 ORDER BY 1, 2', [erratumId])).map(
		(r) => `${r.p}:${r.u}:${r.n}`
	);
const row = (project: string, u: User, runs: number) => `${project}:${u.id}:${runs}`;

beforeAll(async () => {
	[owner, teamAdmin, editor, viewer, otherOwner] = (await Promise.all(['ErOwner', 'ErTeamAdmin', 'ErEditor', 'ErViewer', 'ErOtherOwner'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	unconfirmedOwner = await signUp('ErUnconfirmed', { verified: false });
	affected = (await owner.call('POST', '/projects', { name: 'Erratum <i>catchment</i>' })).body.project.id as string;
	fitOnly = (await otherOwner.call('POST', '/projects', { name: 'Fit catchment' })).body.project.id as string;
	untouched = (await otherOwner.call('POST', '/projects', { name: 'Untouched catchment' })).body.project.id as string;
	rowFit = (await otherOwner.call('POST', '/projects', { name: 'Headline gauge catchment' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${affected}/members`, { email: u.email, role })).status).toBe(201);
	await arrange(async (q) => {
		await q(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [affected, unconfirmedOwner.id]);
		// An owner through the project's team: a team admin.
		const [team] = await q(`INSERT INTO team (name, created_by) VALUES ('Erratum team', $1) RETURNING id::text`, [owner.id]);
		await q(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [team!.id, teamAdmin.id]);
		await q('UPDATE project SET team_id = $2 WHERE id = $1', [affected, team!.id]);
		const run = (project: string, version: string, fit: string | null = null) =>
			q(
				`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, $3, '2020-01-01', '2020-01-02', $4)`,
				[project, owner.id, version, JSON.stringify(fit ? { settings: { fitRecord: { engineVersion: fit } } } : {})]
			);
		// In range: 90.1.0 (the first affected) and 90.2.10 (numerically below 90.3.0, though not as text).
		await run(affected, '90.1.0');
		await run(affected, '90.2.10', '90.0.5');
		// Out of range: below the first affected, at the fix, and not a version at all.
		await run(affected, '90.0.9');
		await run(affected, '90.3.0');
		await run(affected, 'x');
		// Made by a fixed engine, with parameters from an affected fit: only a `fit` erratum reaches it.
		await run(fitOnly, '91.0.0', '90.2.0');
		await run(untouched, '91.0.0');
		// Engine 1.110.0 (issue #659): a headline gauge's fit lives in its row, and the run's summary says which location is the
		// headline (run_fit_engine_version, 289). Made by an engine before every range here, so only a `fit` erratum can reach them.
		const G = crypto.randomUUID();
		const rowRun = (headline: 'gauge' | 'outlet') =>
			q(
				`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, summary) VALUES ($1, $2, '89.0.0', '2020-01-01', '2020-01-02', $3, $4)`,
				[
					rowFit,
					otherOwner.id,
					JSON.stringify({ settings: { fitRecord: null, calibrationZones: [{ nodeId: G, fitRecord: { engineVersion: '90.2.0' } }] } }),
					JSON.stringify({ unitRain: { zones: [{ nodeId: G, kind: 'gauge', ...(headline === 'gauge' ? { headline: true } : {}) }, { nodeId: null, kind: 'outlet', ...(headline === 'outlet' ? { headline: true } : {}) }] } })
				]
			);
		// The affected fit is the headline's in one run, and only another location's in the other: both are reached (313, issue #670).
		await rowRun('gauge');
		await rowRun('outlet');
	});
});

afterAll(async () => {
	await asOwner(`DELETE FROM erratum_notice WHERE erratum_id LIKE 'ER-9%'`);
	await asOwner(`DELETE FROM erratum_sweep WHERE erratum_id LIKE 'ER-9%'`);
});

describe('the sweep', () => {
	it('queues each owner (direct, or the team’s admin) of a project with a run in range, with the count; never an editor, a viewer or an unconfirmed address', async () => {
		expect(await sweepErrata([erratum('ER-9001')])).toBe(2);
		expect(await queued('ER-9001')).toEqual([row(affected, owner, 2), row(affected, teamAdmin, 2)].sort());
	});

	it('keys a `fit` erratum on the fit’s engine, not the run’s: any applied location’s, a gauge’s row included, the headline or not (issues #659, #670)', async () => {
		await sweepErrata([erratum('ER-9002', { keyedOn: 'fit', firstAffected: '90.2.0', fixedIn: null })]);
		expect(await queued('ER-9002')).toEqual([row(fitOnly, otherOwner, 1), row(rowFit, otherOwner, 2)].sort());
	});

	it('an open erratum (no fix yet) reaches every later engine', async () => {
		await sweepErrata([erratum('ER-9003', { firstAffected: '90.3.0', fixedIn: null })]);
		expect(await queued('ER-9003')).toEqual(
			[row(affected, owner, 1), row(affected, teamAdmin, 1), row(fitOnly, otherOwner, 1), row(untouched, otherOwner, 1)].sort()
		);
	});

	it('sweeps a range once: the same list again queues nothing, even with the notices gone; a widened range sweeps again and adds only the new', async () => {
		await asOwner(`DELETE FROM erratum_notice WHERE erratum_id = 'ER-9001' AND user_id = $1`, [teamAdmin.id]);
		expect(await sweepErrata([erratum('ER-9001')])).toBe(0);
		expect(await queued('ER-9001')).toEqual([row(affected, owner, 2)]);
		// Widened to the fixed engines: the other owner's projects join; the owner already mailed isn't queued twice.
		expect(await sweepErrata([erratum('ER-9001', { fixedIn: null })])).toBe(3);
		expect(await queued('ER-9001')).toEqual(
			[row(affected, owner, 2), row(affected, teamAdmin, 3), row(fitOnly, otherOwner, 1), row(untouched, otherOwner, 1)].sort()
		);
	});

	it('refuses a malformed erratum (positive control: a well-formed one is accepted above)', async () => {
		await expect(sweepErrata([erratum('ER-9004', { firstAffected: '1.2' })])).rejects.toMatchObject({ code: '22023' });
		await expect(sweepErrata([erratum('nope')])).rejects.toMatchObject({ code: '22023' });
	});

	it('only the worker sweeps, claims and purges, and water_app writes no notice itself', async () => {
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_erratum_sweep('[]'::jsonb)`))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`SELECT * FROM app_erratum_notice_claim(10, interval '1 minute')`))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_purge_erratum_notices(interval '30 days')`))).rejects.toMatchObject({ code: '42501' });
		await expect(
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count) VALUES ('ER-9099', $1, $2, 1)`, [affected, owner.id])
			)
		).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`INSERT INTO erratum_sweep (erratum_id, keyed_on, first_affected) VALUES ('ER-9099', 'run', '1.0.0')`))).rejects.toMatchObject({
			code: '42501'
		});
		// Positive control: the worker's own context.
		await expect(withoutUser((db) => db.query(`SELECT app_erratum_sweep('[]'::jsonb) AS n`))).resolves.toMatchObject({ rows: [{ n: 0 }] });
	});

	it('a signed-in person reads the sweep record, an API key never (it sees only its own series)', async () => {
		expect((await withUser(viewer.id, (db) => db.query(`SELECT 1 FROM erratum_sweep WHERE erratum_id = 'ER-9001'`))).rowCount).toBe(1);
		const [key] = await asOwner(
			`INSERT INTO api_key (project_id, name, key_hash, created_by) VALUES ($1, 'Erratum key', sha256(random()::text::bytea), $2) RETURNING id::text`,
			[affected, owner.id]
		);
		expect((await withApiKey(key!.id as string, (db) => db.query('SELECT 1 FROM erratum_sweep'))).rowCount).toBe(0);
	});

	it('a person reads their own notices only (positive control: the owner reads theirs)', async () => {
		const mine = await withUser(owner.id, (db) => db.query(`SELECT erratum_id FROM erratum_notice WHERE erratum_id = 'ER-9001'`));
		expect(mine.rowCount).toBe(1);
		const theirs = await withUser(editor.id, (db) => db.query(`SELECT erratum_id FROM erratum_notice WHERE erratum_id = 'ER-9001'`));
		expect(theirs.rowCount).toBe(0);
	});
});

describe('sending', () => {
	const errata = [erratum('ER-9001', { fixedIn: null }), erratum('ER-9002', { keyedOn: 'fit', firstAffected: '90.2.0', fixedIn: null }), erratum('ER-9003', { firstAffected: '90.3.0', fixedIn: null })];

	it('mails each owner once per project, built as them, listing every erratum: the conditions, the count and a link to the runs, the names escaped', async () => {
		// Demoted since the sweep: the team admin is now a team member (an editor), so gets nothing. (The owner joins as
		// a second admin first: a team keeps at least one, 149.)
		const team = (await asOwner('SELECT team_id::text AS t FROM project WHERE id = $1', [affected]))[0]!.t as string;
		await asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [team, owner.id]);
		await asOwner(`UPDATE team_member SET role = 'member' WHERE user_id = $1`, [teamAdmin.id]);
		// Suppressed since the sweep (a bounce): nothing.
		await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce' WHERE id = $1`, [otherOwner.id]);
		try {
			outbox.length = 0;
			const r = await sendErratumNotices({ errata, limit: 500 });
			expect(r.failed).toBe(0);
			// One email for both errata that reach the owner's project (411), not one each.
			const toOwner = outbox.filter((m) => m.to === owner.email && m.kind === 'erratum_notice');
			expect(toOwner.map((m) => m.subject)).toEqual(['2 known engine bugs may affect Erratum <i>catchment</i> — IC-WBT']);
			const m = toOwner[0]!;
			expect(m.text).toContain('ER-9001 and ER-9003');
			expect(m.text).toContain('2 runs in Erratum <i>catchment</i> were made by engine 90.1.0 or later');
			expect(m.text).toContain('1 run in Erratum <i>catchment</i> was made by engine 90.3.0 or later');
			expect(m.text).toContain('It changes results only when: A dam <b>spills</b> on a dry day.');
			expect(m.text).toContain(`/projects/${affected}?tab=runs`);
			expect(m.html).toContain('Erratum &lt;i&gt;catchment&lt;/i&gt;');
			expect(m.html).not.toContain('<b>spills</b>');
			expect(outbox.filter((x) => x.to === teamAdmin.email || x.to === otherOwner.email)).toEqual([]);
			const status = async (u: User, id: string) =>
				(await asOwner(`SELECT status, reason FROM erratum_notice WHERE erratum_id = $1 AND user_id = $2 ORDER BY project_id LIMIT 1`, [id, u.id]))[0];
			// Each erratum keeps its own record that the owner was told.
			expect(await status(owner, 'ER-9001')).toMatchObject({ status: 'sent', reason: null });
			expect(await status(owner, 'ER-9003')).toMatchObject({ status: 'sent', reason: null });
			expect(await status(teamAdmin, 'ER-9001')).toMatchObject({ status: 'skipped', reason: 'no longer an owner of the project' });
			expect(await status(otherOwner, 'ER-9002')).toMatchObject({ status: 'skipped', reason: 'the address is suppressed (a bounce or complaint)' });
			// Settled: a second tick sends nothing.
			outbox.length = 0;
			expect(await sendErratumNotices({ errata })).toEqual({ sent: 0, skipped: 0, failed: 0 });
			expect(outbox).toEqual([]);
		} finally {
			await asOwner(`UPDATE team_member SET role = 'admin' WHERE user_id = $1`, [teamAdmin.id]);
			await asOwner('DELETE FROM team_member WHERE team_id = $1 AND user_id = $2', [team, owner.id]);
			await asOwner(`UPDATE app_user SET mail_suppressed_at = NULL, mail_suppressed_reason = NULL WHERE id = $1`, [otherOwner.id]);
		}
	});

	it('skips an erratum no longer listed (it never is: an erratum stays after its fix)', async () => {
		await asOwner(`INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count) VALUES ('ER-9098', $1, $2, 1)`, [affected, owner.id]);
		outbox.length = 0;
		expect(await sendErratumNotices({ errata })).toMatchObject({ sent: 0, skipped: 1 });
		expect((await asOwner(`SELECT reason FROM erratum_notice WHERE erratum_id = 'ER-9098'`))[0]).toEqual({ reason: 'the erratum is no longer listed' });
	});

	it('is in the owner’s data export', async () => {
		const res = await owner.call('GET', '/auth/me/export');
		expect(res.status).toBe(200);
		const ids = (res.body.erratumNotices as { erratumId: string; projectId: string }[]).map((n) => n.erratumId).sort();
		expect(ids).toEqual(expect.arrayContaining(['ER-9001', 'ER-9003']));
		expect((res.body.erratumNotices as { projectId: string }[]).every((n) => n.projectId === affected)).toBe(true);
	});

	it('purges settled notices after 30 days, never sooner, never an open one', async () => {
		await asOwner(`UPDATE erratum_notice SET settled_at = now() - interval '31 days' WHERE erratum_id = 'ER-9098'`);
		await asOwner(`UPDATE erratum_notice SET status = 'pending', settled_at = now() - interval '31 days' WHERE erratum_id = 'ER-9003' AND user_id = $1`, [owner.id]);
		await expect(withoutUser((db) => db.query(`SELECT app_purge_erratum_notices(interval '1 day')`))).rejects.toMatchObject({ code: '22023' });
		await purgeErratumNotices();
		expect(await asOwner(`SELECT 1 FROM erratum_notice WHERE erratum_id = 'ER-9098'`)).toEqual([]);
		expect((await asOwner(`SELECT status FROM erratum_notice WHERE erratum_id = 'ER-9003' AND user_id = $1`, [owner.id]))[0]).toEqual({ status: 'pending' });
		// Positive control: a recently settled one stays.
		expect((await asOwner(`SELECT status FROM erratum_notice WHERE erratum_id = 'ER-9001' AND user_id = $1`, [owner.id]))[0]).toEqual({ status: 'sent' });
	});
});

describe('the claim’s lease and retries', () => {
	const errata = [erratum('ER-9097')];
	const row = async () =>
		(await asOwner(`SELECT status, attempts, reason, settled_at IS NOT NULL AS settled FROM erratum_notice WHERE erratum_id = 'ER-9097' AND user_id = $1`, [owner.id]))[0];

	beforeAll(async () => {
		// Only this notice open, so each send below claims it alone.
		await asOwner(`UPDATE erratum_notice SET status = 'skipped', settled_at = now(), locked_until = NULL WHERE status IN ('pending', 'sending')`);
		await asOwner(`INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count) VALUES ('ER-9097', $1, $2, 1), ('ER-9097', $1, $3, 1)`, [
			affected,
			owner.id,
			teamAdmin.id
		]);
	});

	it('fails a notice left sending past its lease, never re-sending it; one within its lease is left alone (positive control)', async () => {
		await asOwner(`UPDATE erratum_notice SET status = 'sending', locked_until = now() - interval '1 minute' WHERE erratum_id = 'ER-9097' AND user_id = $1`, [teamAdmin.id]);
		await asOwner(`UPDATE erratum_notice SET status = 'sending', locked_until = now() + interval '5 minutes' WHERE erratum_id = 'ER-9097' AND user_id = $1`, [owner.id]);
		const claimed = await withoutUser((db) => db.query(`SELECT * FROM app_erratum_notice_claim(10, interval '1 minute')`));
		expect(claimed.rows).toEqual([]);
		expect((await asOwner(`SELECT status, reason FROM erratum_notice WHERE erratum_id = 'ER-9097' AND user_id = $1`, [teamAdmin.id]))[0]).toEqual({
			status: 'failed',
			reason: 'the worker stopped while sending'
		});
		expect(await row()).toMatchObject({ status: 'sending', settled: false });
	});

	it('retries a failed send twice, then gives up; the log line names no address; finish needs a claimed notice', async () => {
		await asOwner(`UPDATE erratum_notice SET status = 'pending', attempts = 0, locked_until = NULL WHERE erratum_id = 'ER-9097' AND user_id = $1`, [owner.id]);
		// A transport that fails: SMTP to a closed port.
		vi.stubEnv('MAIL_TRANSPORT', 'smtp');
		vi.stubEnv('SMTP_HOST', '127.0.0.1');
		vi.stubEnv('SMTP_PORT', '1');
		const logs: string[] = [];
		const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
		try {
			for (const [attempts, status] of [
				[1, 'pending'],
				[2, 'pending'],
				[3, 'failed']
			] as const) {
				expect(await sendErratumNotices({ errata })).toEqual({ sent: 0, skipped: 0, failed: 1 });
				expect(await row()).toMatchObject({ status, attempts, settled: status === 'failed' });
			}
			expect(await sendErratumNotices({ errata })).toEqual({ sent: 0, skipped: 0, failed: 0 });
		} finally {
			vi.unstubAllEnvs();
			errSpy.mockRestore();
		}
		const line = logs.find((l) => l.includes('mail_send_failed'));
		expect(line).toContain('erratum_notice');
		expect(line).not.toContain(owner.email);
		expect((await row())!.reason).toMatch(/^send failed \(/);
		expect((await row())!.reason).not.toContain(owner.email);
		// A notice that isn't being sent can't be finished.
		const done = await withoutUser((db) =>
			db.query<{ ok: boolean }>(`SELECT app_erratum_notice_finish('ER-9097', $1, $2, 'sent') AS ok`, [affected, owner.id])
		);
		expect(done.rows[0]!.ok).toBe(false);
	});
});

describe('one email per owner and catchment (411: a release that adds several errata)', () => {
	// Five new errata reach every 90.x run (open, keyed on the run), so each of the owner's catchments is touched by all five.
	const five = ['ER-9201', 'ER-9202', 'ER-9203', 'ER-9204', 'ER-9205'].map((id) => erratum(id, { firstAffected: '90.0.0', fixedIn: null, summary: `Bug ${id}` }));
	const later = erratum('ER-9206', { firstAffected: '90.0.0', fixedIn: null, summary: 'Bug ER-9206' });
	let second: string;
	let third: string;
	const mails = () => outbox.filter((m) => m.kind === 'erratum_notice');

	beforeAll(async () => {
		// Only these notices open, so the sends below see nothing of the tests above.
		await asOwner(`UPDATE erratum_notice SET status = 'skipped', settled_at = now(), locked_until = NULL WHERE status IN ('pending', 'sending')`);
		second = (await owner.call('POST', '/projects', { name: 'Second catchment' })).body.project.id as string;
		third = (await owner.call('POST', '/projects', { name: 'Third catchment' })).body.project.id as string;
		await arrange(async (q) => {
			for (const p of [second, third])
				await q(`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '90.1.0', '2020-01-01', '2020-01-02', '{}')`, [p, owner.id]);
		});
	});

	afterAll(async () => {
		await asOwner(`DELETE FROM erratum_notice WHERE erratum_id LIKE 'ER-92%'`);
		await asOwner(`DELETE FROM erratum_sweep WHERE erratum_id LIKE 'ER-92%'`);
		await asOwner('DELETE FROM project WHERE id IN ($1, $2)', [second, third]);
	});

	it('five new errata: one email per owner per catchment listing all five, each erratum keeping its own sent record', async () => {
		// Swept one at a time, as the tick's single call does in a loop: a notice per erratum, project and owner.
		expect(await sweepErrata(five)).toBeGreaterThan(0);
		const mine = async () =>
			asOwner(`SELECT project_id::text AS p, erratum_id AS e, status FROM erratum_notice WHERE user_id = $1 AND erratum_id LIKE 'ER-92%' ORDER BY 1, 2`, [owner.id]);
		expect((await mine()).filter((r) => r.p === second)).toHaveLength(5);
		outbox.length = 0;
		// A small limit counts emails, not notices: 2 emails' worth claims every notice of 2 (project, owner) pairs, whole.
		const r1 = await sendErratumNotices({ errata: [...ENGINE_ERRATA, ...five], limit: 2 });
		expect(r1.failed).toBe(0);
		expect(mails()).toHaveLength(2);
		const r2 = await sendErratumNotices({ errata: [...ENGINE_ERRATA, ...five], limit: 100 });
		expect(r2.failed).toBe(0);
		const toOwner = mails().filter((m) => m.to === owner.email);
		// The owner's three catchments: three emails, not fifteen.
		expect(toOwner.map((m) => m.subject).sort()).toEqual(
			[
				'5 known engine bugs may affect Erratum <i>catchment</i> — IC-WBT',
				'5 known engine bugs may affect Second catchment — IC-WBT',
				'5 known engine bugs may affect Third catchment — IC-WBT'
			].sort()
		);
		for (const m of toOwner) {
			expect(m.text).toContain('ER-9201, ER-9202, ER-9203, ER-9204 and ER-9205');
			for (const e of five) expect(m.text).toContain(`Bug ${e.id}.`);
		}
		// Every other owner (the team admin of the first catchment, the other owner's catchments) gets one per catchment too.
		const perRecipientAndProject = new Set(mails().map((m) => `${m.to}|${m.subject}`));
		expect(perRecipientAndProject.size).toBe(mails().length);
		expect(mails().every((m) => m.subject.startsWith('5 known engine bugs'))).toBe(true);
		// Each erratum's own record, per project: all sent.
		expect((await mine()).every((r) => r.status === 'sent')).toBe(true);
		expect(await mine()).toHaveLength(15);
	});

	it('a re-sweep and a re-send send nothing: the record is per erratum and project', async () => {
		outbox.length = 0;
		expect(await sweepErrata(five)).toBe(0);
		// Even a forced re-sweep (the range forgotten) queues no notice the owner was already sent.
		await asOwner(`DELETE FROM erratum_sweep WHERE erratum_id LIKE 'ER-92%'`);
		expect(await sweepErrata(five)).toBe(0);
		expect(await sendErratumNotices({ errata: [...ENGINE_ERRATA, ...five] })).toEqual({ sent: 0, skipped: 0, failed: 0 });
		expect(mails()).toEqual([]);
	});

	it('a new erratum later is one email per owner and catchment with just it (positive control: it is sent)', async () => {
		outbox.length = 0;
		expect(await sweepErrata([...five, later])).toBeGreaterThan(0);
		await sendErratumNotices({ errata: [...ENGINE_ERRATA, ...five, later], limit: 500 });
		const toOwner = mails().filter((m) => m.to === owner.email);
		expect(toOwner.map((m) => m.subject).sort()).toEqual(
			[
				'Known engine bug ER-9206 may affect Erratum <i>catchment</i> — IC-WBT',
				'Known engine bug ER-9206 may affect Second catchment — IC-WBT',
				'Known engine bug ER-9206 may affect Third catchment — IC-WBT'
			].sort()
		);
		for (const m of toOwner) {
			expect(m.text).toContain('Bug ER-9206.');
			for (const e of five) expect(m.text).not.toContain(e.id);
		}
	});

	it('a failed send retries the whole email, and every notice it listed settles together', async () => {
		const extra = [erratum('ER-9207', { firstAffected: '90.0.0', fixedIn: null }), erratum('ER-9208', { firstAffected: '90.0.0', fixedIn: null })];
		await sweepErrata(extra);
		// Only the owner's Second catchment left open, so the send below is this one email.
		await asOwner(`UPDATE erratum_notice SET status = 'skipped', settled_at = now() WHERE status = 'pending' AND NOT (user_id = $1 AND project_id = $2)`, [owner.id, second]);
		const rows = async () =>
			asOwner(`SELECT erratum_id AS e, status, attempts FROM erratum_notice WHERE user_id = $1 AND project_id = $2 AND erratum_id IN ('ER-9207', 'ER-9208') ORDER BY 1`, [
				owner.id,
				second
			]);
		vi.stubEnv('MAIL_TRANSPORT', 'smtp');
		vi.stubEnv('SMTP_HOST', '127.0.0.1');
		vi.stubEnv('SMTP_PORT', '1');
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await sendErratumNotices({ errata: [...ENGINE_ERRATA, ...extra] })).toEqual({ sent: 0, skipped: 0, failed: 2 });
			expect(await rows()).toEqual([
				{ e: 'ER-9207', status: 'pending', attempts: 1 },
				{ e: 'ER-9208', status: 'pending', attempts: 1 }
			]);
		} finally {
			vi.unstubAllEnvs();
			errSpy.mockRestore();
		}
		outbox.length = 0;
		expect(await sendErratumNotices({ errata: [...ENGINE_ERRATA, ...extra] })).toEqual({ sent: 2, skipped: 0, failed: 0 });
		expect(mails().map((m) => m.subject)).toEqual(['2 known engine bugs may affect Second catchment — IC-WBT']);
		expect((await rows()).map((r) => r.status)).toEqual(['sent', 'sent']);
	});
});

describe('the worker’s tick', () => {
	it('sweeps a new erratum and sends its notices in the same tick; the next tick queues nothing', async () => {
		// A real erratum (the engine's list, as the tick passes it), forgotten so this tick sweeps it again, and a run it reaches.
		const target = ENGINE_ERRATA.find((e) => e.keyedOn === 'run')!;
		const [planted] = await arrange((q) =>
			q(`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, $3, '2020-01-01', '2020-01-02', '{}') RETURNING id::text`, [
				affected,
				owner.id,
				target.firstAffected
			])
		);
		await asOwner('DELETE FROM erratum_sweep WHERE erratum_id = $1', [target.id]);
		await asOwner('DELETE FROM erratum_notice WHERE erratum_id = $1 AND project_id = $2', [target.id, affected]);
		try {
			outbox.length = 0;
			const first = await runTick({ feeds: false, reports: false, alerts: false, projectIds: [affected] });
			expect(first.erratumNotices.queued).toBeGreaterThanOrEqual(2);
			expect(first.erratumNotices.sent).toBeGreaterThanOrEqual(2);
			// One email per owner for the catchment, naming the erratum (alone, or with any other the same sweep found, 411).
			expect(
				outbox
					.filter((m) => m.kind === 'erratum_notice' && m.subject.includes('may affect Erratum <i>catchment</i>') && m.text.includes(`(${target.id}, severity`))
					.map((m) => m.to)
					.sort()
			).toEqual([owner.email, teamAdmin.email].sort());
			const second = await runTick({ feeds: false, reports: false, alerts: false, projectIds: [affected] });
			expect(second.erratumNotices).toMatchObject({ queued: 0, sent: 0 });
		} finally {
			await asOwner('DELETE FROM model_run WHERE id = $1', [planted!.id]);
			await asOwner('DELETE FROM erratum_notice WHERE erratum_id = $1 AND project_id = $2', [target.id, affected]);
		}
	});
});

describe('the flag on runs (GET …/runs, GET …/runs/:runId)', () => {
	it('names the errata that may affect each run, from the engine’s list; a run on a fixed engine has none', async () => {
		// Engine 0.10.0 had ER-2, ER-4 and ER-5 among others (ER-1 was fixed in 0.7.0; docs/engine-errata.md); the 90.x runs come after every fix.
		const [old] = await arrange((q) =>
			q(`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '0.10.0', '2020-01-01', '2020-01-02', '{}') RETURNING id::text`, [
				affected,
				owner.id
			])
		);
		try {
			const list = await viewer.call('GET', `/projects/${affected}/runs`);
			expect(list.status).toBe(200);
			const byVersion = new Map((list.body.runs as { id: string; engineVersion: string; errata: string[] }[]).map((r) => [r.engineVersion, r.errata]));
			expect(byVersion.get('0.10.0')).toEqual(errataFor('0.10.0', ENGINE_ERRATA).map((e) => e.id));
			expect(byVersion.get('0.10.0')).toEqual(expect.arrayContaining(['ER-2', 'ER-4', 'ER-5']));
			expect(byVersion.get('90.1.0')).toEqual([]);
			const detail = await viewer.call('GET', `/projects/${affected}/runs/${old!.id}`);
			expect(detail.status).toBe(200);
			expect(detail.body.run.errata).toEqual(byVersion.get('0.10.0'));
		} finally {
			await asOwner('DELETE FROM model_run WHERE id = $1', [old!.id]);
		}
	});
});
