// sendWithSlot's failure paths and the slot helpers, with the database stubbed
// (renderSlots.db.test.ts drives the real functions through the tick, but only
// down the happy path and the renderer's answers): a request that can't go
// frees the slot it took, naming the request only once it was named, and the
// error reaches the job. No database.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, answers } = vi.hoisted(() => ({
	calls: [] as { fn: string; params: unknown[] }[],
	answers: { take: true, sent: true, free: true, freeThrows: false }
}));
vi.mock('../db/tx.js', () => ({
	withoutUser: async <T>(fn: (db: unknown) => Promise<T>) =>
		fn({
			query: async (sql: string, params: unknown[]) => {
				const fnName = /SELECT (app_render_slot_\w+)/.exec(sql)![1]!;
				calls.push({ fn: fnName, params });
				if (fnName === 'app_render_slot_free' && answers.freeThrows) throw new Error('the database went away');
				const ok = fnName === 'app_render_slot_take' ? answers.take : fnName === 'app_render_slot_sent' ? answers.sent : answers.free;
				return { rows: [{ ok }] };
			}
		})
}));

const { JobRelease } = await import('../jobs/errors.js');
const { renderRequestId } = await import('../jobs/transport.js');
const { STALE_REQUEST_ERROR } = await import('./render.js');
const { answeredSlot, applicantPackSlot, DEFAULT_RENDER_CONCURRENCY, expiredUnrendered, packSlot, RENDER_SLOT_WAIT_SECONDS, renderConcurrency, reportSlot, sendWithSlot } =
	await import('./renderSlots.js');

const R = '22222222-2222-4222-8222-222222222222';
const JOB = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'a-render-token';

beforeEach(() => {
	calls.length = 0;
	Object.assign(answers, { take: true, sent: true, free: true, freeThrows: false });
});

describe('sendWithSlot', () => {
	it('takes the slot, issues the token, names the slot with the request id and sends: nothing freed', async () => {
		const sent: string[] = [];
		await sendWithSlot(reportSlot(R), JOB, async () => TOKEN, async (t) => void sent.push(t));
		expect(sent).toEqual([TOKEN]);
		expect(calls).toEqual([
			{ fn: 'app_render_slot_take', params: [`report:${R}`, DEFAULT_RENDER_CONCURRENCY, JOB] },
			{ fn: 'app_render_slot_sent', params: [`report:${R}`, renderRequestId(TOKEN)] }
		]);
	});

	it('without a slot, hands the job back to wait RENDER_SLOT_WAIT_SECONDS, issuing no token and sending nothing', async () => {
		answers.take = false;
		const issue = vi.fn(async () => TOKEN);
		const send = vi.fn(async () => {});
		const err = await sendWithSlot(reportSlot(R), JOB, issue, send).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JobRelease);
		expect((err as InstanceType<typeof JobRelease>).delaySeconds).toBe(RENDER_SLOT_WAIT_SECONDS);
		expect(issue).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(calls.map((c) => c.fn)).toEqual(['app_render_slot_take']);
	});

	it('a token that can’t be issued frees the slot as an unnamed one, and the error reaches the job', async () => {
		const send = vi.fn(async () => {});
		await expect(
			sendWithSlot(packSlot(R), JOB, async () => {
				throw new Error('RLS refused the token');
			}, send)
		).rejects.toThrow('RLS refused the token');
		expect(send).not.toHaveBeenCalled();
		expect(calls.at(-1)).toEqual({ fn: 'app_render_slot_free', params: [`pack:${R}`, null] });
	});

	it('a slot lost before it was named (timed out and taken again) sends nothing, and frees only an unnamed slot', async () => {
		answers.sent = false;
		const send = vi.fn(async () => {});
		await expect(sendWithSlot(reportSlot(R), JOB, async () => TOKEN, send)).rejects.toThrow('the render slot was lost before the request was sent');
		expect(send).not.toHaveBeenCalled();
		expect(calls.map((c) => c.fn)).toEqual(['app_render_slot_take', 'app_render_slot_sent', 'app_render_slot_free']);
		expect(calls.at(-1)!.params).toEqual([`report:${R}`, null]);
	});

	it('a send that fails frees the slot by its request id, so a later answer to another request is untouched', async () => {
		await expect(
			sendWithSlot(applicantPackSlot(R), JOB, async () => TOKEN, async () => {
				throw new Error('SQS refused the message');
			})
		).rejects.toThrow('SQS refused the message');
		expect(calls.at(-1)).toEqual({ fn: 'app_render_slot_free', params: [`applicant_pack:${R}`, renderRequestId(TOKEN)] });
	});

	it('keeps the send’s error when freeing the slot fails too (the slot frees on its own 10 minutes)', async () => {
		answers.freeThrows = true;
		await expect(
			sendWithSlot(reportSlot(R), JOB, async () => TOKEN, async () => {
				throw new Error('SQS refused the message');
			})
		).rejects.toThrow('SQS refused the message');
	});
});

describe('renderConcurrency', () => {
	it('takes a positive whole RENDER_CONCURRENCY, else the renderer’s default', () => {
		expect(renderConcurrency('5')).toBe(5);
		for (const v of [undefined, '', ' ', '0', '-1', '1.5', 'two']) expect(renderConcurrency(v), String(v)).toBe(DEFAULT_RENDER_CONCURRENCY);
	});
});

describe('answeredSlot', () => {
	it('names the slot of the report, the pack, or the applicant’s copy the answer is for', () => {
		const result = { ok: true as const, pages: 1, bytes: 1, ms: 1 };
		expect(answeredSlot({ v: 1, type: 'rendered', reportId: R, result } as never)).toBe(`report:${R}`);
		expect(answeredSlot({ v: 1, type: 'rendered_pack', packId: R, result } as never)).toBe(`pack:${R}`);
		expect(answeredSlot({ v: 1, type: 'rendered_pack', packId: R, copy: 'applicant', result } as never)).toBe(`applicant_pack:${R}`);
	});
});

describe('expiredUnrendered', () => {
	it('is only a retryable failure with the stale-request error: nothing was rendered', () => {
		expect(expiredUnrendered({ ok: false, error: STALE_REQUEST_ERROR, retry: true })).toBe(true);
		expect(expiredUnrendered({ ok: false, error: STALE_REQUEST_ERROR, retry: false })).toBe(false);
		expect(expiredUnrendered({ ok: false, error: 'the render took longer than 90 s', retry: true })).toBe(false);
		expect(expiredUnrendered({ ok: true, error: STALE_REQUEST_ERROR, retry: true })).toBe(false);
	});
});
