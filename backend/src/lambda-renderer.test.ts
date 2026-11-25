// The renderer Lambda's message handling (lambda-renderer.ts), with the
// browser, storage and queue stubbed: the render itself is covered against
// real Chromium and MinIO in reports/render.db.test.ts.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sent: { url: string | undefined; message: unknown }[] = [];
const sendToQueue = vi.fn(async (url: string | undefined, _name: string, message: unknown) => {
	sent.push({ url, message });
});
vi.mock('./jobs/transport.js', async (orig) => ({ ...(await orig<typeof import('./jobs/transport.js')>()), sendToQueue: (u: string, n: string, m: unknown) => sendToQueue(u, n, m) }));
const renderReportPdf = vi.fn();
vi.mock('./reports/render.js', async (orig) => ({ ...(await orig<typeof import('./reports/render.js')>()), renderReportPdf: (...a: unknown[]) => renderReportPdf(...a) }));
const putPdf = vi.fn(async (_key: string, _body: Uint8Array) => {});
const putPackPdf = vi.fn(async (_key: string, _body: Uint8Array, _sha256: string) => {});
vi.mock('./reports/storage.js', async (orig) => ({
	...(await orig<typeof import('./reports/storage.js')>()),
	putPdf: (k: string, b: Uint8Array) => putPdf(k, b),
	putPackPdf: (k: string, b: Uint8Array, h: string) => putPackPdf(k, b, h)
}));

const { handler } = await import('./lambda-renderer.js');
const { RenderError } = await import('./reports/render.js');
const { renderRequestId } = await import('./jobs/transport.js');

afterEach(() => {
	sent.length = 0;
	sendToQueue.mockClear();
	renderReportPdf.mockReset();
	putPdf.mockClear();
	putPackPdf.mockReset();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const ids = { reportId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', runId: '00000000-0000-4000-8000-000000000003' };
const TOKEN = 'a'.repeat(43);
// The request's id, echoed in every answer so the worker frees only that request's render slot (353).
const RID = renderRequestId(TOKEN);
const request = { v: 1, type: 'render', ...ids, token: TOKEN };
const record = (messageId: string, body: unknown) => ({ messageId, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('renderer Lambda', () => {
	it('names each answer with a one-way digest of its request’s token, never the token or the token store’s hash', () => {
		expect(RID).toMatch(/^[0-9a-f]{32}$/);
		expect(RID).not.toContain(TOKEN);
		expect(createHash('sha256').update(TOKEN).digest('hex')).not.toContain(RID);
		// One request, one id; another token, another.
		expect(renderRequestId(TOKEN)).toBe(RID);
		expect(renderRequestId('b'.repeat(43))).not.toBe(RID);
	});

	it('renders, stores under the derived key, and answers with the outcome only (never the token)', async () => {
		vi.stubEnv('RENDER_RESULTS_QUEUE_URL', 'https://sqs.example/render-results');
		const log = vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF-1.7 x'), pages: 9, ms: 4200 });
		const res = await handler({ Records: [record('m1', request)] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(renderReportPdf).toHaveBeenCalledWith({ projectId: ids.projectId, runId: ids.runId, token: TOKEN }, expect.objectContaining({ timeoutMs: 90_000 }));
		expect(putPdf).toHaveBeenCalledWith(`reports/${ids.projectId}/${ids.reportId}.pdf`, expect.any(Buffer));
		expect(sent).toEqual([
			{ url: 'https://sqs.example/render-results', message: { v: 1, type: 'rendered', reportId: ids.reportId, requestId: RID, result: { ok: true, pages: 9, bytes: 10, ms: 4200 } } }
		]);
		expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
	});

	it('answers a failed render as a failure (its token is spent: no SQS retry)', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockRejectedValueOnce(new RenderError('the render took longer than 90 s'));
		const res = await handler({ Records: [record('m1', request)] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(putPdf).not.toHaveBeenCalled();
		expect(sent[0]!.message).toEqual({ v: 1, type: 'rendered', reportId: ids.reportId, requestId: RID, result: { ok: false, error: 'the render took longer than 90 s', retry: true } });
	});

	it('says only "could not be stored" when storage fails', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF'), pages: 1, ms: 1 });
		putPdf.mockRejectedValueOnce(new Error('AccessDenied: arn:aws:s3:::bucket/key'));
		await handler({ Records: [record('m1', request)] } as never);
		expect(sent[0]!.message).toMatchObject({ result: { ok: false, error: 'the PDF could not be stored' } });
		expect(err).toHaveBeenCalled();
	});

	it('logs a failed render as report_render_failed: ids, reason and retry, never the error text (infra/reports.tf alarms on it)', async () => {
		vi.stubEnv('RENDER_RESULTS_QUEUE_URL', 'https://sqs.example/render-results');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		renderReportPdf.mockRejectedValueOnce(new RenderError('the render token was refused (used, expired, or the requester lost access)', { retry: false }));
		renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF'), pages: 1, ms: 1 });
		await handler({ Records: [record('m1', request), record('m2', request)] } as never);
		expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'report_render_failed', reportId: ids.reportId, projectId: ids.projectId, reason: 'render', retry: false })]]);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
	});

	it('logs a storage failure as reason "store", and the store error by its name only', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF'), pages: 1, ms: 1 });
		putPdf.mockRejectedValueOnce(Object.assign(new Error('AccessDenied: arn:aws:s3:::bucket/key'), { name: 'AccessDenied' }));
		await handler({ Records: [record('m1', request)] } as never);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'report_render_failed', reportId: ids.reportId, projectId: ids.projectId, reason: 'store', retry: true }));
		expect(err).toHaveBeenCalledWith(JSON.stringify({ event: 'report_store_failed', reportId: ids.reportId, error: 'AccessDenied' }));
		expect(JSON.stringify(err.mock.calls)).not.toContain('arn:aws');
	});

	it('logs no report_render_failed line while the answer is still being retried', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		renderReportPdf.mockRejectedValueOnce(new RenderError('the render took longer than 90 s'));
		sendToQueue.mockRejectedValueOnce(new Error('RENDER_RESULTS_QUEUE_URL is not set'));
		const res = await handler({ Records: [record('m1', request)] } as never);
		expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
		expect(warn).not.toHaveBeenCalled();
	});

	// A burst (a Monday's schedules, two renders at a time) can keep a request queued past its token's 5 minutes.
	// The API would refuse that token as final (render_token_refused): the request is answered as retryable
	// instead, without a browser, so the worker asks again with a fresh token.
	it('answers a request that waited past its token’s life as retryable, without rendering', async () => {
		vi.stubEnv('RENDER_RESULTS_QUEUE_URL', 'https://sqs.example/render-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { sessionRefusal } = await import('./reports/render.js');
		renderReportPdf.mockRejectedValue(sessionRefusal(400, { code: 'render_token_refused' }));
		const sentAt = String(Date.now() - 6 * 60_000);
		const res = await handler({ Records: [{ ...record('m1', request), attributes: { SentTimestamp: sentAt } }] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(renderReportPdf).not.toHaveBeenCalled();
		expect(sent[0]!.message).toEqual({
			v: 1,
			type: 'rendered',
			reportId: ids.reportId,
			requestId: RID,
			result: { ok: false, error: 'the request waited too long in the queue: its render token expired', retry: true }
		});
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'report_render_failed', reportId: ids.reportId, projectId: ids.projectId, reason: 'expired', retry: true }));
	});

	it('renders a request sent within its token’s life (or with no sent time)', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValue({ pdf: Buffer.from('%PDF'), pages: 1, ms: 1 });
		const sentAt = String(Date.now() - 2 * 60_000);
		await handler({ Records: [{ ...record('m1', request), attributes: { SentTimestamp: sentAt } }, record('m2', request)] } as never);
		expect(renderReportPdf).toHaveBeenCalledTimes(2);
		expect(sent.map((m) => (m.message as { result: { ok: boolean } }).result.ok)).toEqual([true, true]);
	});

	it('drops a request it cannot parse, and retries only a failed answer', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValue({ pdf: Buffer.from('%PDF'), pages: 1, ms: 1 });
		sendToQueue.mockRejectedValueOnce(new Error('RENDER_RESULTS_QUEUE_URL is not set'));
		const res = await handler({ Records: [record('m0', 'garbage'), record('m1', { ...request, token: 'short' }), record('m2', request), record('m3', request)] } as never);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'render_request_ignored', messageId: 'm0' }));
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'render_request_ignored', messageId: 'm1' }));
		expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
	});
});

// An issued evidence pack (119_pack_render): the same browser, its own bucket, and an answer carrying the PDF's hash.
describe('renderer Lambda, an evidence pack', () => {
	const pack = { packId: '00000000-0000-4000-8000-000000000006', projectId: ids.projectId };
	const packRequest = { v: 1, type: 'render_pack', ...pack, token: TOKEN };
	const bytes = Buffer.from('%PDF-1.7 an issued pack');
	const SHA = createHash('sha256').update(bytes).digest('hex');

	it('prints the pack’s page, stores it under its content address with its hash, and answers with that hash (never the token)', async () => {
		vi.stubEnv('RENDER_RESULTS_QUEUE_URL', 'https://sqs.example/render-results');
		const log = vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 12, ms: 3100 });
		const res = await handler({ Records: [record('m1', packRequest)] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(renderReportPdf).toHaveBeenCalledWith({ projectId: pack.projectId, packId: pack.packId, token: TOKEN }, expect.objectContaining({ timeoutMs: 90_000 }));
		expect(putPackPdf).toHaveBeenCalledWith(`packs/${pack.projectId}/${pack.packId}/${SHA}.pdf`, bytes, SHA);
		expect(putPdf).not.toHaveBeenCalled();
		expect(sent).toEqual([
			{
				url: 'https://sqs.example/render-results',
				message: { v: 1, type: 'rendered_pack', packId: pack.packId, requestId: RID, result: { ok: true, pages: 12, bytes: bytes.length, ms: 3100, sha256: SHA } }
			}
		]);
		expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
	});

	it('answers a failed render as a failure, stores nothing, and logs report_render_failed with the pack’s id (the renderer alarm)', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		renderReportPdf.mockRejectedValueOnce(new RenderError('the render token was refused (used, expired, or the requester lost access)', { retry: false }));
		await handler({ Records: [record('m1', packRequest)] } as never);
		expect(putPackPdf).not.toHaveBeenCalled();
		expect(sent[0]!.message).toEqual({
			v: 1,
			type: 'rendered_pack',
			packId: pack.packId,
			requestId: RID,
			result: { ok: false, error: 'the render token was refused (used, expired, or the requester lost access)', retry: false }
		});
		expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'report_render_failed', packId: pack.packId, projectId: pack.projectId, reason: 'render', retry: false })]]);
	});

	it('says only "could not be stored" when the packs bucket refuses the put, logging the error by its name', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 1, ms: 1 });
		putPackPdf.mockRejectedValueOnce(Object.assign(new Error('BadDigest: arn:aws:s3:::packs/key'), { name: 'BadDigest' }));
		await handler({ Records: [record('m1', packRequest)] } as never);
		expect(sent[0]!.message).toMatchObject({ type: 'rendered_pack', result: { ok: false, error: 'the PDF could not be stored', retry: true } });
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'report_render_failed', packId: pack.packId, projectId: pack.projectId, reason: 'store', retry: true }));
		expect(err).toHaveBeenCalledWith(JSON.stringify({ event: 'pack_store_failed', packId: pack.packId, error: 'BadDigest' }));
		expect(JSON.stringify(err.mock.calls)).not.toContain('arn:aws');
	});

	it('answers a pack request that waited past its token’s life as retryable, without rendering', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		renderReportPdf.mockResolvedValue({ pdf: bytes, pages: 1, ms: 1 });
		const sentAt = String(Date.now() - 6 * 60_000);
		await handler({ Records: [{ ...record('m1', packRequest), attributes: { SentTimestamp: sentAt } }] } as never);
		expect(renderReportPdf).not.toHaveBeenCalled();
		expect(putPackPdf).not.toHaveBeenCalled();
		expect(sent[0]!.message).toEqual({
			v: 1,
			type: 'rendered_pack',
			packId: pack.packId,
			requestId: RID,
			result: { ok: false, error: 'the request waited too long in the queue: its render token expired', retry: true }
		});
	});

	it('refuses a PDF with no pages, and retries only a failed answer', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 0, ms: 1 });
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 2, ms: 1 });
		sendToQueue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('RENDER_RESULTS_QUEUE_URL is not set'));
		const res = await handler({ Records: [record('m1', packRequest), record('m2', packRequest)] } as never);
		expect(putPackPdf).toHaveBeenCalledTimes(1);
		expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
	});
});

// An applicant's copy (165_applicant_copy): the party's page, stored under applicant/, and an answer that says so.
describe("renderer Lambda, an applicant's copy of a pack", () => {
	const pack = { packId: '00000000-0000-4000-8000-000000000006', projectId: ids.projectId };
	const S = '00000000-0000-4000-8000-000000000007';
	const bytes = Buffer.from("%PDF-1.7 an applicant's copy");
	const SHA = createHash('sha256').update(bytes).digest('hex');

	it("prints the party's page, stores it under applicant/ by its own hash, and answers `copy: 'applicant'`", async () => {
		vi.stubEnv('RENDER_RESULTS_QUEUE_URL', 'https://sqs.example/render-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 3, ms: 900 });
		const res = await handler({ Records: [record('m1', { v: 1, type: 'render_pack', ...pack, scenarioId: S, token: TOKEN })] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(renderReportPdf).toHaveBeenCalledWith({ projectId: pack.projectId, packId: pack.packId, scenarioId: S, token: TOKEN }, expect.objectContaining({ timeoutMs: 90_000 }));
		expect(putPackPdf).toHaveBeenCalledWith(`packs/${pack.projectId}/${pack.packId}/applicant/${SHA}.pdf`, bytes, SHA);
		expect(sent).toEqual([
			{
				url: 'https://sqs.example/render-results',
				message: { v: 1, type: 'rendered_pack', packId: pack.packId, copy: 'applicant', requestId: RID, result: { ok: true, pages: 3, bytes: bytes.length, ms: 900, sha256: SHA } }
			}
		]);
	});
});
