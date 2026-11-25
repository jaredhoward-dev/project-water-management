// Render slots (353_render_slot; docs/architecture.md § Render slots): the
// worker never has more render requests in flight to the renderer Lambda than
// the renderer runs at once (RENDER_CONCURRENCY, the same number infra/
// reports.tf gives the renderer's SQS trigger as maximum_concurrency). A
// report_render, pack_render or applicant_pack_render job takes a slot before
// it issues its 5-minute render token and sends; without one it goes back to
// the job table (JobRelease, its attempt given back) and asks again in
// RENDER_SLOT_WAIT_SECONDS, keeping its place in line. A slot frees when the
// renderer answers (lambda-worker.ts, any answer), when the send fails, or
// on its own 10 minutes after it was taken (an answer lost or dead-lettered).
//
// Only REPORT_RENDERER=sqs takes slots: inline, the job renders itself, one
// at a time per worker.
import { withoutUser } from '../db/tx.js';
import { JobRelease } from '../jobs/errors.js';
import type { PackRenderResultMessage, RenderResultMessage } from '../jobs/transport.js';
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

/** Take a slot for `target`, or false: it waits in line (app_render_slot_take). */
export async function takeRenderSlot(target: RenderSlotTarget, limit = renderConcurrency()): Promise<boolean> {
	const { rows } = await withoutUser((db) => db.query<{ ok: boolean }>('SELECT app_render_slot_take($1, $2) AS ok', [target, limit]));
	return rows[0]?.ok === true;
}

/** Free `target`'s slot (the answer came, or the send failed). False when it held none. */
export async function freeRenderSlot(target: RenderSlotTarget): Promise<boolean> {
	const { rows } = await withoutUser((db) => db.query<{ ok: boolean }>('SELECT app_render_slot_free($1) AS ok', [target]));
	return rows[0]?.ok === true;
}

/**
 * The sqs branch of a render job: take a slot (else hand the job back, its
 * attempt given back), then issue the token and send, freeing the slot if
 * either throws. The token is issued only here, once the request can go.
 */
export async function sendWithSlot(target: RenderSlotTarget, send: () => Promise<void>): Promise<void> {
	if (!(await takeRenderSlot(target))) throw new JobRelease('waiting for a free render slot', RENDER_SLOT_WAIT_SECONDS);
	try {
		await send();
	} catch (err) {
		await freeRenderSlot(target).catch(() => {});
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
