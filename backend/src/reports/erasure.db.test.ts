// A deleted report's PDF leaves storage (395_report_pdf_erasure, issue #903):
// both account deletion paths (DELETE /auth/me and the operator's SQL) and a
// project's deletion queue the requester's report ids through the trigger on
// `report`, and the worker's tick removes each PDF and settles the queue.
// Storage is a stand-in here (the remover argument); reports/storage.ts
// deletePdf is the same S3 DeleteObject for MinIO and the bucket.
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser, withoutUser } from '../db/tx.js';
import { erasePendingReportPdfs } from './erasure.js';
import { reportKey } from './storage.js';
import { createReport } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** Each test's projects: their queued report renders are retired after it (db-setup.ts refuses leftovers). */
const projects: string[] = [];
afterEach(async () => {
	await retirePendingJobs(...projects.splice(0));
});

/** A project owned by `owner` with one run (the reports.db.test.ts fixture). */
async function withRun(owner: User) {
	const projectId = (await owner.call('POST', '/projects', { name: 'Erasure' })).body.project.id as string;
	projects.push(projectId);
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, {});
	expect(run.status).toBe(201);
	return { projectId, runId: run.body.run.id as string };
}

/** `u` joins as a viewer and asks for a report; returns the report's id. */
async function reportBy(owner: User, u: User, projectId: string, runId: string, join = true): Promise<string> {
	if (join) expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role: 'viewer' })).status).toBe(201);
	const { jobId } = await withUser(u.id, (db) => createReport(db, { projectId, runId, emailTo: [] }));
	const [row] = await asOwner('SELECT id FROM report WHERE job_id = $1', [jobId]);
	return row.id as string;
}

async function queued(reportIds: string[]): Promise<{ report_id: string; attempts: number }[]> {
	return asOwner('SELECT report_id, attempts FROM report_pdf_erasure WHERE report_id = ANY ($1::uuid[]) ORDER BY report_id', [reportIds]);
}

/** Drain the whole queue with a stand-in remover, returning the keys it was asked to delete. */
async function drain(fail: (key: string) => boolean = () => false): Promise<string[]> {
	const keys: string[] = [];
	await erasePendingReportPdfs(1000, async (key) => {
		keys.push(key);
		if (fail(key)) throw new Error('storage refused');
	});
	return keys;
}

describe('report PDF erasure (395, issue #903)', () => {
	it('removes the PDFs of a self-deleted account (DELETE /auth/me), and only theirs', async () => {
		const owner = await signUp('Owner');
		const leaver = await signUp('Leaver');
		const { projectId, runId } = await withRun(owner);
		const theirs = await reportBy(owner, leaver, projectId, runId);
		const kept = await reportBy(owner, owner, projectId, runId, false);
		await drain(); // anything earlier tests left
		expect((await leaver.call('DELETE', '/auth/me', { password: 'correct horse' })).status).toBeLessThan(300);
		expect(await queued([theirs, kept])).toEqual([{ report_id: theirs, attempts: 0 }]);
		const keys = await drain();
		expect(keys).toContain(reportKey(projectId, theirs));
		expect(keys).not.toContain(reportKey(projectId, kept));
		expect(await queued([theirs])).toEqual([]);
	});

	it("removes the PDFs of an account the operator deletes in SQL, and a deleted project's", async () => {
		const owner = await signUp('Owner');
		const gone = await signUp('Gone');
		const { projectId, runId } = await withRun(owner);
		const theirs = await reportBy(owner, gone, projectId, runId);
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		expect(await queued([theirs])).toEqual([{ report_id: theirs, attempts: 0 }]);

		const other = await withRun(owner);
		const ownersReport = await reportBy(owner, owner, other.projectId, other.runId, false);
		await asOwner('DELETE FROM project WHERE id = $1', [other.projectId]);
		expect(await queued([ownersReport])).toEqual([{ report_id: ownersReport, attempts: 0 }]);

		const keys = await drain();
		expect(keys).toEqual(expect.arrayContaining([reportKey(projectId, theirs), reportKey(other.projectId, ownersReport)]));
		expect(await queued([theirs, ownersReport])).toEqual([]);
	});

	it('keeps an entry whose delete failed, with an attempt counted, for the next tick', async () => {
		const owner = await signUp('Owner');
		const gone = await signUp('Gone');
		const { projectId, runId } = await withRun(owner);
		const theirs = await reportBy(owner, gone, projectId, runId);
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		const key = reportKey(projectId, theirs);
		expect(await drain((k) => k === key)).toContain(key);
		expect(await queued([theirs])).toEqual([{ report_id: theirs, attempts: 1 }]);
		expect(await drain()).toContain(key);
		expect(await queued([theirs])).toEqual([]);
	});

	it("doesn't queue a row past the PDFs' retention (purgeReports' own)", async () => {
		const owner = await signUp('Owner');
		const { projectId, runId } = await withRun(owner);
		const old = await reportBy(owner, owner, projectId, runId, false);
		await asOwner("UPDATE report SET created_at = now() - interval '9 days' WHERE id = $1", [old]);
		await asOwner('DELETE FROM report WHERE id = $1', [old]);
		expect(await queued([old])).toEqual([]);
	});

	it('is the worker\'s alone: water_app has no grant on the queue, and a signed-in user is refused', async () => {
		const u = await signUp('Someone');
		await expect(withUser(u.id, (db) => db.query('SELECT * FROM app_report_pdf_erasures(10)'))).rejects.toMatchObject({ code: '42501' });
		await expect(withoutUser((db) => db.query('SELECT * FROM report_pdf_erasure'))).rejects.toMatchObject({ code: '42501' });
	});
});
