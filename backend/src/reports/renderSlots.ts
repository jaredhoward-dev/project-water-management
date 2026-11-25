// Render slots (353_render_slot; docs/architecture.md § Render slots): the
// worker never has more render requests in flight to the renderer Lambda than
// the renderer runs at once (RENDER_CONCURRENCY, the same number infra/
// reports.tf gives the renderer's SQS trigger as maximum_concurrency). A
// report_render, pack_render or applicant_pack_render job takes a slot before
// it issues its 5-minute render token and sends; without one it goes back to
// the job table (JobRelease, its attempt given back) and asks again in
// RENDER_SLOT_WAIT_SECONDS, keeping its place in line. A slot frees when the
// renderer answers that request (lambda-worker.ts, any answer carrying the
// slot's request id: a stale or redelivered answer of an earlier request
// frees nothing), when the send fails, or on its own 10 minutes after it was
// taken (an answer lost or dead-lettered). Each time one frees, the oldest
// waiter is made due at once and the worker woken (app_render_slot_wake).
//
// Only REPORT_RENDERER=sqs takes slots: inline, the job renders itself, one
// at a time per worker.
import { withoutUser } from '../db/tx.js';
import { JobRelease } from '../jobs/errors.js';
import { type PackRenderResultMessage, renderRequestId, type RenderResultMessage } from '../jobs/transport.js';
import { STALE_REQUEST_ERROR } from './render.js';

/** How many renders the renderer runs at once (infra/reports.tf local.renderer_concurrency). */
export const DEFAULT_RENDER_CONCURRENCY = 2;

/** How long a request without a slot waits before it asks again. */
export const RENDER_SLOT_WAIT_SECONDS = 15;

export type RenderSlotTarget = `report:${string}` | `pack:${string}` | `applicant_pack:${string}`;

export const reportSlot = (reportId: string): RenderSlotTarget => `report:${reportId}`;
export const packSlot = (packId: string): RenderSlotTarget => `pack:${packId}`;
export const applicantPackSlot = (packId: string): RenderSlotTarget => `applicant_pack:${packId}`;

/** The slot a render-results message answers for. */
export function answeredSlot(msg: RenderResultMessage | PackRenderResultMessage): RenderSlotTarget {
	if (msg.type === 'rendered') return reportSlot(msg.reportId);
	return msg.copy === 'applicant' ? applicantPackSlot(msg.packId) : packSlot(msg.packId);
}

export function renderConcurrency(value: string | undefined = process.env.RENDER_CONCURRENCY): number {
	// As runner.ts envInt (not imported: the runner imports the handlers that import this).
	const n = Number(value);
	return value !== undefined && value.trim() !== '' && Number.isInteger(n) && n > 0 ? n : DEFAULT_RENDER_CONCURRENCY;
}

/** Take a slot for `target`, or false: it waits in line, `jobId` its asker (app_render_slot_take). */
export async function takeRenderSlot(target: RenderSlotTarget, jobId: string | null, limit = renderConcurrency()): Promise<boolean> {
	const { rows } = await withoutUser((db) => db.query<{ ok: boolean }>('SELECT app_render_slot_take($1, $2, $3) AS ok', [target, limit, jobId]));
	return rows[0]?.ok === true;
}

/** Name the request about to go on `target`'s slot (app_render_slot_sent). False when it holds no unnamed slot. */
export async function nameRenderSlot(target: RenderSlotTarget, requestId: string): Promise<boolean> {
	const { rows } = await withoutUser((db) => db.query<{ ok: boolean }>('SELECT app_render_slot_sent($1, $2) AS ok', [target, requestId]));
	return rows[0]?.ok === true;
}

/**
 * Free `target`'s slot: the answer to `requestId` came, or the send failed.
 * False when the slot in flight isn't that request's (a stale answer). An
 * answer without one (a renderer older than 353) frees only a slot not yet
 * named, so it frees nothing it can't prove is its own; that slot frees on
 * its 10 minutes.
 */
export async function freeRenderSlot(target: RenderSlotTarget, requestId: string | null | undefined): Promise<boolean> {
	const { rows } = await withoutUser((db) => db.query<{ ok: boolean }>('SELECT app_render_slot_free($1, $2) AS ok', [target, requestId ?? null]));
	return rows[0]?.ok === true;
}

/**
 * The sqs branch of a render job: take a slot (else hand the job back, its
 * attempt given back), then issue the token, name the slot with the
 * request's id and send, freeing the slot if any of it throws. The token is
 * issued only here, once the request can go, and the slot is named before
 * the send, so the answer can't arrive before it.
 */
export async function sendWithSlot(target: RenderSlotTarget, jobId: string, issue: () => Promise<string>, send: (token: string) => Promise<void>): Promise<void> {
	if (!(await takeRenderSlot(target, jobId))) throw new JobRelease('waiting for a free render slot', RENDER_SLOT_WAIT_SECONDS);
	let requestId: string | null = null;
	try {
		const token = await issue();
		const id = renderRequestId(token);
		if (!(await nameRenderSlot(target, id))) throw new Error('the render slot was lost before the request was sent');
		requestId = id;
		await send(token);
	} catch (err) {
		await freeRenderSlot(target, requestId).catch(() => {});
		throw err;
	}
}

/**
 * The renderer refused a request only because it waited past its token's
 * life (reports/render.ts staleRenderRequest: SQS's SentTimestamp, so an SQS
 * redelivery after a visibility timeout too). Nothing was rendered, so it
 * never counts toward REPORT_MAX_ATTEMPTS.
 */
export const expiredUnrendered = (result: { ok: boolean; error?: string; retry?: boolean }): boolean =>
	!result.ok && result.retry === true && result.error === STALE_REQUEST_ERROR;

/** At most this many expired, never-rendered answers are asked again for one target, so a stuck renderer still ends. */
export const MAX_EXPIRED_REQUESTS = 5;
