// "A known engine bug may affect your results" emails: the known-defect
// procedure's notice (issue #103, Gate D; docs/legal/known-defect-procedure.md,
// 153_erratum_notices.sql). The pattern is the pack notices'
// (evidence/notices.ts):
//
//   1. Swept by the worker's tick (sweepErrata): the engine's ENGINE_ERRATA,
//      generated from docs/engine-errata.md, goes to app_erratum_sweep, which
//      looks at the runs only for an erratum it hasn't swept with that range
//      and queues one erratum_notice per erratum, project and owner whose
//      project holds a run the erratum may affect. So a new erratum is mailed
//      on the first tick after the deploy that carries it, once.
//   2. Sent by the same tick (sendErratumNotices): one email per owner and
//      project, listing every erratum claimed for them (411: the claim hands
//      over whole (project, owner) groups, so a release that adds five errata
//      sends one email per catchment, not five). Each email is built in a
//      transaction *as its recipient* (withUser), under RLS: still an owner
//      now, a confirmed address that SES hasn't suppressed since, and the
//      project's name as they may read it. The mail goes out after that
//      transaction; each erratum's notice records the outcome in the worker's
//      own context, so the record stays per erratum and project. A transport
//      error is retried on the next tick (3 attempts in all); a worker that
//      dies mid-send leaves the notices failed, never sent twice.
//
// The erratum's words come from the engine's list, not the database: the
// claim carries its id only.
import { ENGINE_ERRATA, type Erratum } from '@water-management/engine';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { NOTICE_SUPPRESSED } from '../evidence/notices.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { erratumNoticeMail } from '../mail/templates.js';
import { sendMail, type Mail } from '../mail/transport.js';

/** Settled notices are kept this long, then the tick deletes them (app_purge_erratum_notices). */
export const ERRATUM_NOTICE_RETENTION_DAYS = 30;

const LEASE = '10 minutes';

/**
 * Queue the notices of every erratum not yet swept with its current range
 * (the worker's own context). Returns how many were queued; 0 on a tick
 * where the list is unchanged, at one primary-key lookup per erratum.
 */
export async function sweepErrata(errata: readonly Erratum[] = ENGINE_ERRATA): Promise<number> {
	const list = errata.map((e) => ({ id: e.id, keyedOn: e.keyedOn, firstAffected: e.firstAffected, fixedIn: e.fixedIn }));
	const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_erratum_sweep($1::jsonb) AS n', [JSON.stringify(list)]));
	return rows[0]?.n ?? 0;
}

export interface ClaimedErratumNotice {
	erratum_id: string;
	project_id: string;
	user_id: string;
	run_count: number;
}

/** Counted per erratum notice (row), not per email: one email settles every notice it lists. */
export interface ErratumNoticeResult {
	sent: number;
	skipped: number;
	failed: number;
}

/** One owner's claimed notices for one project: one email. */
export interface ErratumNoticeGroup {
	project_id: string;
	user_id: string;
	notices: ClaimedErratumNotice[];
}

type Prepared = { mail: Mail; listed: ClaimedErratumNotice[]; unlisted: ClaimedErratumNotice[] } | { skip: string };

/**
 * One owner's email about one project, listing every claimed erratum still in
 * the engine's list, built as its recipient (the transaction's user), or why
 * not. A notice whose erratum is no longer listed is left out (unlisted).
 */
export async function prepareErratumNotice(db: Db, g: ErratumNoticeGroup, errata: readonly Erratum[] = ENGINE_ERRATA): Promise<Prepared> {
	const listed: { c: ClaimedErratumNotice; erratum: Erratum }[] = [];
	const unlisted: ClaimedErratumNotice[] = [];
	for (const c of g.notices) {
		const erratum = errata.find((e) => e.id === c.erratum_id);
		if (erratum) listed.push({ c, erratum });
		else unlisted.push(c);
	}
	if (!listed.length) return { skip: 'the erratum is no longer listed' };
	const { rows } = await db.query<{ email: string; verified: boolean; suppressed: boolean; role: string | null; project: string | null }>(
		`SELECT u.email, u.email_verified_at IS NOT NULL AS verified, u.mail_suppressed_at IS NOT NULL AS suppressed,
			app_project_role($1)::text AS role, (SELECT p.name FROM project p WHERE p.id = $1) AS project
		 FROM app_user u WHERE u.id = app_current_user_id()`,
		[g.project_id]
	);
	const me = rows[0];
	if (!me?.verified || !me.project) return { skip: 'no longer a member, or no confirmed address' };
	if (me.suppressed) return { skip: NOTICE_SUPPRESSED };
	// The audience again, now: an owner (or the project's team admin, 094).
	if (me.role !== 'owner') return { skip: 'no longer an owner of the project' };
	const byId = (a: { erratum: Erratum }, b: { erratum: Erratum }) => Number(a.erratum.id.slice(3)) - Number(b.erratum.id.slice(3));
	listed.sort(byId);
	return {
		mail: erratumNoticeMail(me.email, {
			projectId: g.project_id,
			projectName: me.project,
			errata: listed.map(({ c, erratum }) => ({ erratum, runCount: c.run_count }))
		}),
		listed: listed.map((x) => x.c),
		unlisted
	};
}

const finish = (c: ClaimedErratumNotice, status: 'sent' | 'skipped' | 'retry', reason: string | null = null) =>
	withoutUser((db) => db.query('SELECT app_erratum_notice_finish($1, $2, $3, $4, $5)', [c.erratum_id, c.project_id, c.user_id, status, reason]));

/** Settle every notice in `cs` the same way, counting each. */
async function finishAll(cs: ClaimedErratumNotice[], status: 'sent' | 'skipped' | 'retry', reason: string | null, r: ErratumNoticeResult): Promise<void> {
	for (const c of cs) {
		await finish(c, status, reason);
		r[status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : 'failed']++;
	}
}

/** Never the raw error text (SES writes the address into it): its name and code only. */
const failureReason = (err: unknown) => `send failed (${safeError(err).error})`;

async function deliver(g: ErratumNoticeGroup, r: ErratumNoticeResult, errata: readonly Erratum[]): Promise<void> {
	let p: Prepared;
	try {
		p = await withUser(g.user_id, (db) => prepareErratumNotice(db, g, errata), { readOnly: true });
	} catch (err) {
		logEvent('error', { event: 'erratum_notice_prepare_failed', erratumIds: g.notices.map((c) => c.erratum_id), ...safeError(err) });
		await finishAll(g.notices, 'retry', failureReason(err), r);
		return;
	}
	if ('skip' in p) {
		await finishAll(g.notices, 'skipped', p.skip, r);
		return;
	}
	await finishAll(p.unlisted, 'skipped', 'the erratum is no longer listed', r);
	try {
		await sendMail(p.mail);
	} catch (err) {
		// The line the mail-send-failed alarm counts (infra/alarms.tf), as trySendMail's: kind and error code only.
		logEvent('error', { event: 'mail_send_failed', kind: 'erratum_notice', ...safeError(err) });
		await finishAll(p.listed, 'retry', failureReason(err), r);
		return;
	}
	await finishAll(p.listed, 'sent', null, r);
}

/** The claimed notices as one group per (project, owner), in the claim's order. */
export function groupNotices(rows: readonly ClaimedErratumNotice[]): ErratumNoticeGroup[] {
	const groups = new Map<string, ErratumNoticeGroup>();
	for (const c of rows) {
		const key = `${c.project_id}:${c.user_id}`;
		let g = groups.get(key);
		if (!g) groups.set(key, (g = { project_id: c.project_id, user_id: c.user_id, notices: [] }));
		g.notices.push(c);
	}
	return [...groups.values()];
}

/**
 * Send the pending notices (see the header): up to `limit` emails, each one
 * owner's for one project with every erratum pending for them. Every
 * transport's tick ends here, after the pack notices.
 */
export async function sendErratumNotices({ limit = 100, errata = ENGINE_ERRATA }: { limit?: number; errata?: readonly Erratum[] } = {}): Promise<ErratumNoticeResult> {
	const r: ErratumNoticeResult = { sent: 0, skipped: 0, failed: 0 };
	const { rows } = await withoutUser((db) =>
		db.query<ClaimedErratumNotice>('SELECT erratum_id, project_id, user_id, run_count FROM app_erratum_notice_claim($1, $2::interval)', [limit, LEASE])
	);
	for (const g of groupNotices(rows)) await deliver(g, r, errata);
	return r;
}

/** Delete settled notices older than the retention (the tick). */
export async function purgeErratumNotices(days = ERRATUM_NOTICE_RETENTION_DAYS): Promise<number> {
	const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_purge_erratum_notices(make_interval(days => $1)) AS n', [days]));
	return rows[0]?.n ?? 0;
}
