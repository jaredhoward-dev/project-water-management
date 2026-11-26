// A deleted report's PDF leaves storage (395_report_pdf_erasure, issue #903):
// both account deletion paths (DELETE /auth/me and the operator's SQL) and a
// project's deletion queue the requester's report ids through the trigger on
// `report`, and the worker's tick removes each PDF and settles the queue.
// Storage is a stand-in here (the remover argument); reports/storage.ts
// deletePdf is the same S3 DeleteObject for MinIO and the bucket.
//
// A render still in progress when its report goes (issue #911, 398) stores
// its PDF after the deletion's erasure ran: the inline render asks
// app_report_pdf_orphaned right after storing, and the worker asks it when
// the renderer Lambda's answer arrives, so the late PDF is queued too. The
// render and the store are stand-ins (the real ones: render.db.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser, withoutUser } from '../db/tx.js';
import { reportRenderHandler } from '../jobs/handlers/report-render.js';
import { erasePendingReportPdfs } from './erasure.js';
import { acceptRenderResult } from './schedule.js';
import { reportKey } from './storage.js';
import { createReport } from './store.js';

const stand = vi.hoisted(() => ({
	render: async (): Promise<void> => {},
	stored: [] as string[]
}));
vi.mock('./render.js', async (orig) => ({
	...(await orig<typeof import('./render.js')>()),
	renderReportPdf: async () => {
		await stand.render();
		return { pdf: Buffer.from('%PDF-stand-in'), pages: 1, ms: 1 };
	}
}));
vi.mock('./storage.js', async (orig) => ({
	...(await orig<typeof import('./storage.js')>()),
	putPdf: async (key: string) => {
		stand.stored.push(key);
	}
}));

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

describe('a PDF stored after its report was deleted (398, issue #911)', () => {
	afterEach(() => {
		stand.render = async () => {};
		stand.stored.length = 0;
		vi.unstubAllEnvs();
	});

	/** Run the report_render handler on `reportId` inline, as the worker does: in the acting user's transaction. */
	async function renderInline(u: User, projectId: string, reportId: string) {
		vi.stubEnv('REPORT_RENDERER', 'inline');
		const [{ jobId }] = await asOwner('SELECT job_id AS "jobId" FROM report WHERE id = $1', [reportId]);
		const job = { id: jobId as string, projectId, kind: 'report_render' as const, actingUserId: u.id, leaseToken: crypto.randomUUID(), attempts: 1, maxAttempts: 3 };
		await withUser(u.id, (db) => reportRenderHandler.run({ db, job, payload: { reportId }, progress: async () => true }));
	}

	it('inline: the requester deleted mid-render, after the erasure ran, still has the PDF removed', async () => {
		const owner = await signUp('Owner');
		const leaver = await signUp('Leaver');
		const { projectId, runId } = await withRun(owner);
		const theirs = await reportBy(owner, leaver, projectId, runId);
		await drain(); // anything earlier tests left
		// While the browser prints: the account goes (DELETE /auth/me), and the tick's erasure runs on the queued ids before any PDF exists.
		stand.render = async () => {
			expect((await leaver.call('DELETE', '/auth/me', { password: 'correct horse' })).status).toBeLessThan(300);
			expect(await drain()).toContain(reportKey(projectId, theirs));
			expect(await queued([theirs])).toEqual([]);
		};
		await renderInline(leaver, projectId, theirs);
		const key = reportKey(projectId, theirs);
		expect(stand.stored).toEqual([key]);
		// The PDF stored afterwards is queued again, and the next tick removes it.
		expect(await queued([theirs])).toEqual([{ report_id: theirs, attempts: 0 }]);
		expect(await drain()).toContain(key);
		expect(await queued([theirs])).toEqual([]);
	});

	it('inline (positive control): a report that still exists is recorded, and nothing is queued', async () => {
		const owner = await signUp('Owner');
		const { projectId, runId } = await withRun(owner);
		const mine = await reportBy(owner, owner, projectId, runId, false);
		await renderInline(owner, projectId, mine);
		expect(stand.stored).toEqual([reportKey(projectId, mine)]);
		expect(await asOwner('SELECT status FROM report WHERE id = $1', [mine])).toEqual([{ status: 'done' }]);
		expect(await queued([mine])).toEqual([]);
	});

	it("the renderer Lambda's answer for a deleted report queues its PDF; a live report's answer (a redelivery) doesn't", async () => {
		const owner = await signUp('Owner');
		const gone = await signUp('Gone');
		const { projectId, runId } = await withRun(owner);
		const theirs = await reportBy(owner, gone, projectId, runId);
		const kept = await reportBy(owner, owner, projectId, runId, false);
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		await drain(); // the deletion's own erasure ran before the Lambda stored the PDF
		const ok = { ok: true as const, pages: 2, bytes: 1024, ms: 50 };
		expect(await acceptRenderResult({ v: 1, type: 'rendered', reportId: theirs, projectId, result: ok })).toBe('orphan_queued');
		expect(await queued([theirs])).toEqual([{ report_id: theirs, attempts: 0 }]);
		expect(await drain()).toContain(reportKey(projectId, theirs));

		// Positive control: an answered report's PDF is live, so its redelivered answer queues nothing.
		await asOwner(`UPDATE report SET status = 'done', finished_at = now() WHERE id = $1`, [kept]);
		expect(await acceptRenderResult({ v: 1, type: 'rendered', reportId: kept, projectId, result: ok })).toBe('unknown_report');
		// Nor does naming another project: the check is by report id alone.
		expect(await acceptRenderResult({ v: 1, type: 'rendered', reportId: kept, projectId: crypto.randomUUID(), result: ok })).toBe('unknown_report');
		expect(await queued([kept])).toEqual([]);
		// A failed render stored nothing, and an answer from an older renderer names no project: neither queues anything.
		const other = crypto.randomUUID();
		expect(await acceptRenderResult({ v: 1, type: 'rendered', reportId: other, projectId, result: { ok: false, error: 'x', retry: false } })).toBe('unknown_report');
		expect(await acceptRenderResult({ v: 1, type: 'rendered', reportId: other, result: ok })).toBe('unknown_report');
		expect(await queued([other])).toEqual([]);
	});
});
