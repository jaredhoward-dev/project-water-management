// A project's background jobs (docs/api.md § Jobs): the status list. Jobs are
// queued by the server itself (automatic re-runs, feeds, alerts, yield and
// report requests through their own routes); a person can't queue one here.
// POST /projects/:id/jobs (a manual re-run) was removed on 2026-11-25: no
// page, script or spec called it. The rerun handler still runs a `manual`
// job, for any queued before then.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { requireRole } from '../projects/access.js';
import { JOB_STATUSES, listJobs } from './queue.js';

const ListQuery = z.object({
	status: z.enum(JOB_STATUSES).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});

export const jobRoutes = new Hono<AuthEnv>()
	// A contributor (an applicant) lists only their own yield jobs (RLS,
	// job_select_contributor, 096): how the Yield panel on the Applicant view
	// follows the job it queued. Everyone else needs viewer. Caller: api.jobs.list
	// (frontend/src/lib/api/client.ts), from YieldPanel.svelte.
	.get('/:id/jobs', async (c) => {
		const q = ListQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'contributor');
			return c.json({ jobs: await listJobs(db, c.req.param('id'), q) });
		});
	});
