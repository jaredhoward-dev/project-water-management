// Removing a deleted report's PDF from storage (395_report_pdf_erasure,
// issue #903; docs/security.md § Personal information).
//
// A report row goes when its requester's account or its project is deleted,
// by either path (DELETE /auth/me, or the operator's SQL), and a trigger on
// `report` queues its ids. The worker's tick (jobs/runner.ts) claims a batch,
// deletes each PDF from the reports bucket (MinIO under STORAGE=local, the
// private bucket under s3, where the worker's role may delete reports/*), and
// settles the batch: the entries whose object is gone are dropped, the rest
// count an attempt and come back next tick. S3 answers a delete of a missing
// key with success, so a report that never got a PDF settles at once.
import { withoutUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { deletePdf, reportKey } from './storage.js';

/** PDFs removed per tick at most: a large deletion drains over a few ticks. */
export const REPORT_PDF_ERASURE_BATCH = 100;

export interface ReportPdfErasureResult {
	removed: number;
	failed: number;
}

export async function erasePendingReportPdfs(
	limit = REPORT_PDF_ERASURE_BATCH,
	remove: (key: string) => Promise<void> = deletePdf
): Promise<ReportPdfErasureResult> {
	return withoutUser(async (db) => {
		const { rows } = await db.query<{ id: string; projectId: string; reportId: string }>(
			'SELECT id, project_id AS "projectId", report_id AS "reportId" FROM app_report_pdf_erasures($1)',
			[limit]
		);
		const done: string[] = [];
		const failed: string[] = [];
		for (const r of rows) {
			try {
				await remove(reportKey(r.projectId, r.reportId));
				done.push(r.id);
			} catch (err) {
				failed.push(r.id);
				logEvent('warn', { event: 'report_pdf_erasure_failed', reportId: r.reportId, ...safeError(err) });
			}
		}
		if (rows.length > 0) await db.query('SELECT app_report_pdf_erasures_settle($1::bigint[], $2::bigint[])', [done, failed]);
		return { removed: done.length, failed: failed.length };
	});
}
