// A server report's count (408, issue #939; docs/billing.md § Shadow mode):
//  - a report is counted when queued against its project's account, and the owner-only report_usage records that
//    account and SAST month (never readable by the project's viewers);
//  - each of the three ways a report ends failed gives the count back, once: its status set failed (the renderer's
//    failure), its job dead (attempts used up) or gone, and the renderer silent past the hour (the tick's sweep);
//  - a refunded report that finishes after all is counted again; a report that finishes normally keeps its count;
//  - a project moved to another account after the report was queued leaves the count, and its refund, where it was;
//  - nobody counts a report twice or someone else's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { createReport } from '../reports/store.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let projectId: string;
let runId: string;
let account: string;

/** A project with one run (reports.db.test.ts's fixture). */
async function withRun(u: User, name: string) {
	const pid = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await u.call('POST', `/projects/${pid}/runs`, {});
	expect(run.status).toBe(201);
	return { pid, run: run.body.run.id as string };
}

/** This SAST month's reports count of an account. */
const used = async (acct: string) =>
	Number(
		(
			(await asOwner(
				`SELECT coalesce(sum(qty), 0) AS q FROM usage_counter WHERE billing_account_id = $1 AND kind = 'reports' AND month = app_billing_month()`,
				[acct]
			)) as { q: string }[]
		)[0]!.q
	);
const accountOf = async (pid: string) => ((await asOwner('SELECT billing_account_id AS id FROM project WHERE id = $1', [pid])) as { id: string }[])[0]!.id;

/** Queue a report as the owner; returns its id and job. */
async function queue(pid = projectId, run = runId): Promise<{ id: string; jobId: string }> {
	const { jobId } = await withUser(owner.id, (db) => createReport(db, { projectId: pid, runId: run, emailTo: [] }));
	const [r] = await asOwner('SELECT id FROM report WHERE job_id = $1', [jobId]);
	return { id: r.id as string, jobId };
}
/** The report's owner-only usage row (report_usage), or nulls when it was never counted. */
const usage = async (id: string) =>
	((await asOwner(
		`SELECT u.billing_account_id AS usage_account_id, u.month::text AS usage_month, coalesce(u.refunded_at IS NOT NULL, false) AS refunded
		 FROM report r LEFT JOIN report_usage u ON u.report_id = r.id WHERE r.id = $1`,
		[id]
	)) as {
		usage_account_id: string | null;
		usage_month: string | null;
		refunded: boolean;
	}[])[0]!;
const sqlState = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);

beforeAll(async () => {
	owner = await signUp('ReportUsage');
	({ pid: projectId, run: runId } = await withRun(owner, 'Report usage'));
	account = await accountOf(projectId);
});
afterAll(() => retirePendingJobs(projectId));

describe('counting a report (408)', () => {
	it('counts it against the project’s account this SAST month and records where', async () => {
		const before = await used(account);
		const { id } = await queue();
		expect(await used(account)).toBe(before + 1);
		const [{ month }] = await asOwner('SELECT app_billing_month()::text AS month');
		expect(await usage(id)).toEqual({ usage_account_id: account, usage_month: month, refunded: false });
	});

	it('keeps the count of a report that finishes (control)', async () => {
		const { id } = await queue();
		const before = await used(account);
		await asOwner(`UPDATE report SET status = 'done', pages = 1, bytes = 10, finished_at = now() WHERE id = $1`, [id]);
		expect(await used(account)).toBe(before);
		expect((await usage(id)).refunded).toBe(false);
	});

	it('refuses a second count and someone else’s report, and keeps where it counted owner only', async () => {
		const { id } = await queue();
		// Not in the transaction that queued it: refused, nothing counted twice.
		expect(await sqlState(withUser(owner.id, (db) => db.query('SELECT app_report_count_usage($1)', [id])))).toBe('42501');
		const other = await signUp('ReportUsageOther');
		expect(await sqlState(withUser(other.id, (db) => db.query('SELECT app_report_count_usage($1)', [id])))).toBe('42501');
		// Where it counted is owner only: the app role, signed in as a viewer of the report or not, reads and writes none of it.
		for (const sql of ['SELECT * FROM report_usage', `UPDATE report_usage SET refunded_at = now()`, 'DELETE FROM report_usage']) {
			expect(await sqlState(withUser(owner.id, (db) => db.query(sql))), sql).toBe('42501');
			expect(await sqlState(withoutUser((db) => db.query(sql))), sql).toBe('42501');
		}
		// report itself carries no billing column for viewers to read.
		const cols = (await asOwner(`SELECT column_name FROM information_schema.columns WHERE table_name = 'report' AND column_name LIKE 'usage%'`)) as unknown[];
		expect(cols).toEqual([]);
		// Positive control: the owner reads the row.
		expect((await usage(id)).usage_account_id).toBe(account);
	});
});

describe('a report that ends failed gives its count back (408)', () => {
	it('way 1: its status set failed (the renderer’s failure), once', async () => {
		const { id } = await queue();
		const before = await used(account);
		await asOwner(`UPDATE report SET status = 'failed', error = 'the renderer failed: boom', finished_at = now() WHERE id = $1`, [id]);
		expect(await used(account)).toBe(before - 1);
		expect((await usage(id)).refunded).toBe(true);
		// Another write to the failed report refunds nothing more.
		await asOwner(`UPDATE report SET error = 'again' WHERE id = $1`, [id]);
		expect(await used(account)).toBe(before - 1);
	});

	it('way 2: its job dead (attempts used up), or gone while unfinished (the 30-day job clean-up lets the cleared job_id through, 148)', async () => {
		const dead = await queue();
		const before = await used(account);
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now() WHERE id = $1`, [dead.jobId]);
		expect(await used(account)).toBe(before - 1);
		expect((await usage(dead.id)).refunded).toBe(true);

		// The job purged (aged past 30 days) while the report never finished: shown failed, so refunded.
		const gone = await queue();
		// Control: a finished report's job purged keeps its count.
		const finished = await queue();
		await asOwner(`UPDATE report SET status = 'done', pages = 1, bytes = 10, finished_at = now() WHERE id = $1`, [finished.id]);
		const before2 = await used(account);
		await asOwner(`UPDATE job SET status = 'done', finished_at = now() - interval '31 days' WHERE id = ANY($1::uuid[])`, [[gone.jobId, finished.jobId]]);
		await withoutUser((db) => db.query(`SELECT app_purge_jobs(interval '30 days')`));
		expect(await asOwner('SELECT job_id FROM report WHERE id = ANY($1::uuid[])', [[gone.id, finished.id]])).toEqual([{ job_id: null }, { job_id: null }]);
		expect(await used(account)).toBe(before2 - 1);
		expect((await usage(gone.id)).refunded).toBe(true);
		expect((await usage(finished.id)).refunded).toBe(false);
	});

	it('way 3: the renderer silent past the hour, by the tick’s sweep (the worker’s alone); a live render is left alone', async () => {
		const silent = await queue();
		const live = await queue();
		await asOwner(`UPDATE report SET status = 'rendering', sent_at = now() - interval '61 minutes' WHERE id = $1`, [silent.id]);
		await asOwner(`UPDATE report SET status = 'rendering', sent_at = now() - interval '5 minutes' WHERE id = $1`, [live.id]);
		expect(await sqlState(withUser(owner.id, (db) => db.query('SELECT app_report_usage_refund_silent()')))).toBe('42501');
		const before = await used(account);
		const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_report_usage_refund_silent() AS n'));
		expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
		expect(await used(account)).toBe(before - 1);
		expect((await usage(silent.id)).refunded).toBe(true);
		expect((await usage(live.id)).refunded).toBe(false);
		// The sweep again: nothing more.
		await withoutUser((db) => db.query('SELECT app_report_usage_refund_silent()'));
		expect(await used(account)).toBe(before - 1);

		// The renderer answers late after all: the report is done, so it counts again.
		await asOwner(`UPDATE report SET status = 'done', pages = 1, bytes = 10, finished_at = now() WHERE id = $1`, [silent.id]);
		expect(await used(account)).toBe(before);
		expect((await usage(silent.id)).refunded).toBe(false);
	});
});

describe('a moved project’s reports stay with the account they were counted against (408)', () => {
	it('the count and its refund stay on the old account; the new one is untouched, and counts reports queued after the move', async () => {
		const { pid, run } = await withRun(owner, 'Report usage moved');
		const oldAccount = await accountOf(pid);
		const queued = await queue(pid, run);
		const teamId = (await owner.call('POST', '/teams', { name: `Report usage ${crypto.randomUUID().slice(0, 8)}` })).body.team.id as string;
		expect((await owner.call('PATCH', `/projects/${pid}`, { teamId })).status).toBe(200);
		const newAccount = await accountOf(pid);
		expect(newAccount).not.toBe(oldAccount);

		const oldBefore = await used(oldAccount);
		const newBefore = await used(newAccount);
		await asOwner(`UPDATE report SET status = 'failed', error = 'x', finished_at = now() WHERE id = $1`, [queued.id]);
		expect(await used(oldAccount)).toBe(oldBefore - 1);
		expect(await used(newAccount)).toBe(newBefore);
		expect((await usage(queued.id)).usage_account_id).toBe(oldAccount);

		// Positive control: a report queued after the move counts against the new account.
		await queue(pid, run);
		expect(await used(newAccount)).toBe(newBefore + 1);
		await retirePendingJobs(pid);
	});
});
