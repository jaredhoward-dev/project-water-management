// Render slots (353_render_slot, reports/renderSlots.ts): with
// REPORT_RENDERER=sqs the worker never has more render requests in flight
// than the renderer runs at once (RENDER_CONCURRENCY), each issues its render
// token only when it is sent, and the rest wait in the job table, in order,
// without spending attempts. A slot frees on the renderer's answer (success or
// failure) and on its own after 10 minutes (an answer that never came).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import type { RenderResultMessage } from '../jobs/transport.js';
import { STALE_REQUEST_ERROR } from './render.js';
import { answeredSlot, freeRenderSlot, packSlot, type RenderSlotTarget, reportSlot, takeRenderSlot } from './renderSlots.js';
import { acceptRenderResult } from './schedule.js';

const { sent } = vi.hoisted(() => ({ sent: [] as { reportId: string; token: string }[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: { reportId: string; token: string }) => void sent.push(message)
}));

type User = Awaited<ReturnType<typeof signUp>>;

beforeEach(async () => {
	// The line is global: start each test with none in flight or waiting.
	await asOwner('DELETE FROM render_slot');
	sent.length = 0;
	vi.stubEnv('REPORT_RENDERER', 'sqs');
	vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'memory://render-requests');
	vi.stubEnv('RENDER_CONCURRENCY', '2');
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM render_slot');
});

const id = () => crypto.randomUUID();

describe('app_render_slot_take / app_render_slot_free', () => {
	it('lets `limit` in flight, keeps the rest in line in the order they asked, and lets none jump the line', async () => {
		const [a, b, c, d] = [id(), id(), id(), id()].map((x) => reportSlot(x)) as [RenderSlotTarget, RenderSlotTarget, RenderSlotTarget, RenderSlotTarget];
		expect(await takeRenderSlot(a, 2)).toBe(true);
		expect(await takeRenderSlot(b, 2)).toBe(true);
		expect(await takeRenderSlot(c, 2)).toBe(false);
		expect(await takeRenderSlot(d, 2)).toBe(false);
		// One target in flight is never sent twice beside itself.
		expect(await takeRenderSlot(a, 2)).toBe(false);
		// a's answer frees a slot: d asks first, but c is ahead of it.
		expect(await freeRenderSlot(a)).toBe(true);
		expect(await takeRenderSlot(d, 2)).toBe(false);
		expect(await takeRenderSlot(c, 2)).toBe(true);
		// A second answer for the same target frees nothing more.
		expect(await freeRenderSlot(a)).toBe(false);
		expect(await asOwner(`SELECT target, state FROM render_slot ORDER BY seq`)).toEqual([
			{ target: b, state: 'sent' },
			{ target: c, state: 'sent' },
			{ target: d, state: 'waiting' }
		]);
	});

	it('frees a slot whose answer never came 10 minutes after it was taken, and drops a waiter that stopped asking', async () => {
		const [a, b, c] = [id(), id(), id()].map((x) => packSlot(x)) as [RenderSlotTarget, RenderSlotTarget, RenderSlotTarget];
		expect(await takeRenderSlot(a, 1)).toBe(true);
		expect(await takeRenderSlot(b, 1)).toBe(false);
		expect(await asOwner(`SELECT round(extract(epoch FROM expires_at - sent_at))::int AS s FROM render_slot WHERE target = $1`, [a])).toEqual([{ s: 600 }]);
		// a's answer was lost, and b stopped asking (its report deleted): both expire.
		await asOwner(`UPDATE render_slot SET expires_at = now() - interval '1 second'`);
		expect(await takeRenderSlot(c, 1)).toBe(true);
		expect(await asOwner(`SELECT target FROM render_slot`)).toEqual([{ target: c }]);
	});

	it('is the worker’s alone: a signed-in member can neither take nor free one, and the table grants nothing', async () => {
		const u = await signUp('SlotMember');
		const t = reportSlot(id());
		await expect(withUser(u.id, (db) => db.query('SELECT app_render_slot_take($1, 2)', [t]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(u.id, (db) => db.query('SELECT app_render_slot_free($1)', [t]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(u.id, (db) => db.query('SELECT * FROM render_slot'))).rejects.toMatchObject({ code: '42501' });
		// Positive control: the worker's context takes it.
		expect(await takeRenderSlot(t, 2)).toBe(true);
	});
});

/** A project with one run (reports.db.test.ts's fixture). */
async function withRun(u: User) {
	const projectId = (await u.call('POST', '/projects', { name: 'Slots' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	expect((await u.call('POST', `/projects/${projectId}/runs`, {})).status).toBe(201);
	return projectId;
}

describe('a burst of reports through the queue (REPORT_RENDERER=sqs)', () => {
	it('keeps at most RENDER_CONCURRENCY in flight, sends the rest in order as slots free, and spends no attempt waiting', async () => {
		const owner = await signUp('SlotBurst');
		const projectId = await withRun(owner);
		const tick = () => runTick({ feeds: false, reports: false, alerts: false, projectIds: [projectId] });
		// The waiters' 15 s are up (what time would do).
		const later = () => asOwner(`UPDATE job SET run_after = now() WHERE project_id = $1 AND status = 'queued'`, [projectId]);
		/** What the worker does with a render-results message (lambda-worker.ts): free the slot, queue the answer. */
		const answer = async (msg: RenderResultMessage) => {
			await freeRenderSlot(answeredSlot(msg));
			expect(await acceptRenderResult(msg)).toBe('queued');
		};
		const ok = (reportId: string): RenderResultMessage => ({ v: 1, type: 'rendered', reportId, result: { ok: true, pages: 4, bytes: 1000, ms: 900 } });
		const tokens = async () => (await asOwner(`SELECT count(*)::int AS n FROM render_token WHERE project_id = $1`, [projectId]))[0].n as number;

		const N = 5;
		const reports: string[] = [];
		for (let i = 0; i < N; i++) {
			const res = await owner.call('POST', `/projects/${projectId}/reports`, {});
			expect(res.status).toBe(202);
			reports.push((await asOwner('SELECT id FROM report WHERE job_id = $1', [res.body.jobId]))[0].id);
		}

		const first = await tick();
		expect(first.released).toBe(N - 2);
		expect(sent.map((m) => m.reportId)).toEqual(reports.slice(0, 2));
		// A token only for each request sent: the waiting ones have none to expire.
		expect(await tokens()).toBe(2);

		// Even with every waiter due again, nothing more goes until an answer frees a slot.
		await later();
		await tick();
		expect(sent).toHaveLength(2);

		// One answer at a time: each frees exactly one slot, taken by the next in line.
		let inFlight = reports.slice(0, 2);
		let next = 2;
		while (inFlight.length) {
			const done = inFlight.shift()!;
			await answer(ok(done));
			await later();
			await tick();
			if (next < N) inFlight.push(reports[next++]!);
			expect(sent.map((m) => m.reportId)).toEqual(reports.slice(0, next));
			const slots = await asOwner(`SELECT count(*)::int AS n FROM render_slot WHERE state = 'sent'`);
			expect(slots[0].n).toBeLessThanOrEqual(2);
		}
		expect(await asOwner(`SELECT status FROM report WHERE project_id = $1 ORDER BY created_at`, [projectId])).toEqual(reports.map(() => ({ status: 'done' })));
		// Waiting spent nothing: every request job ran once, on its first and only counted attempt.
		const jobs = await asOwner(`SELECT status, attempts FROM job WHERE project_id = $1 AND kind = 'report_render' AND NOT (payload ? 'result')`, [projectId]);
		expect(jobs).toEqual(reports.map(() => ({ status: 'done', attempts: 1 })));
		expect(await asOwner(`SELECT count(*)::int AS n FROM render_slot`)).toEqual([{ n: 0 }]);
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});

	it('frees the slot on a failed answer, and asks again uncounted for one that only waited past its token’s life', async () => {
		const owner = await signUp('SlotExpired');
		const projectId = await withRun(owner);
		const tick = () => runTick({ feeds: false, reports: false, alerts: false, projectIds: [projectId] });
		const answer = async (msg: RenderResultMessage) => {
			await freeRenderSlot(answeredSlot(msg));
			expect(await acceptRenderResult(msg)).toBe('queued');
		};
		const queue = async () => {
			const res = await owner.call('POST', `/projects/${projectId}/reports`, {});
			return (await asOwner('SELECT id FROM report WHERE job_id = $1', [res.body.jobId]))[0].id as string;
		};

		// A final failure: the report fails, and its slot is free.
		const f = await queue();
		await tick();
		expect(await asOwner(`SELECT target FROM render_slot WHERE state = 'sent'`)).toEqual([{ target: `report:${f}` }]);
		await answer({ v: 1, type: 'rendered', reportId: f, result: { ok: false, error: 'the page refused the render session', retry: false } });
		await tick();
		expect((await asOwner('SELECT status FROM report WHERE id = $1', [f]))[0].status).toBe('failed');
		expect(await asOwner(`SELECT count(*)::int AS n FROM render_slot`)).toEqual([{ n: 0 }]);

		// Expired answers (an SQS redelivery, a stalled renderer): more of them than REPORT_MAX_ATTEMPTS, and the report
		// still renders, since none of them rendered anything.
		const r = await queue();
		await tick();
		for (let i = 0; i < 4; i++) {
			await answer({ v: 1, type: 'rendered', reportId: r, result: { ok: false, error: STALE_REQUEST_ERROR, retry: true } });
			await tick(); // the answer: asks again at once, uncounted
			await tick(); // the new request: takes the freed slot, a fresh token
			expect((await asOwner('SELECT status FROM report WHERE id = $1', [r]))[0].status).toBe('rendering');
		}
		expect(sent.filter((m) => m.reportId === r)).toHaveLength(5);
		expect(new Set(sent.filter((m) => m.reportId === r).map((m) => m.token)).size).toBe(5);
		await answer({ v: 1, type: 'rendered', reportId: r, result: { ok: true, pages: 2, bytes: 10, ms: 5 } });
		await tick();
		expect((await asOwner('SELECT status FROM report WHERE id = $1', [r]))[0].status).toBe('done');
		await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	});
});
