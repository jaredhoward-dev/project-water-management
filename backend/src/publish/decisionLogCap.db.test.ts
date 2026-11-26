// The season decision log of a cap or full-allocation run published before
// 213 (issue #523 finding I): the `publication.published` audit event keeps
// each farm's figures (decision.ts `perFarm`), and of such a run they are
// worked out from each farm's registered volume. A viewer kept from the
// volumes reads the History and the restriction log, so the event reaches
// them through app_audit_subject; it must come without the per-farm figures
// (the count stays, as verdictsOnly's counts do). Positive controls: the
// editor reads them, a viewer the switch lets reads them, and a compare-only
// publication's figures reach the viewer. Synthetic data only: such a run is
// made by marking a compare-only run's summary as the engine recorded a cap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { buildLadder, clearLadderJobs, type LadderCtx } from '../__tests__/routeSamples.js';

const ctx = {} as LadderCtx;
let at: string;
let later: string;

const markMode = (runId: string, mode: string) =>
	asOwner(`UPDATE model_run SET summary = jsonb_set(summary, '{allocations}', $2::jsonb) WHERE id = $1`, [
		runId,
		JSON.stringify({ mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [] })
	]);

type Event = { type: string; kind: string; subject: Record<string, unknown> };

/** The `publication.published` subjects `who` reads in the History, by run id. */
const published = async (who: LadderCtx['viewer']) => {
	const r = await who.call('GET', `${at}/history?kind=publication.published&limit=100`);
	expect(r.status).toBe(200);
	return new Map((r.body.items as Event[]).filter((e) => e.kind === 'publication.published').map((e) => [e.subject.runId as string, e.subject]));
};

beforeAll(async () => {
	Object.assign(ctx, await buildLadder('DecisionCap'));
	at = `/projects/${ctx.projectId}`;
	// A later compare-only run, published: its event's figures are the viewer's (positive control).
	later = (await ctx.owner.call('POST', `${at}/runs`, { label: 'Compare only' })).body.run.id as string;
	const pub = await ctx.owner.call('POST', `${at}/publication`, { runId: later });
	expect(pub.status).toBe(201);
	// The ladder's first publication's run ran in cap mode (before 213).
	await markMode(ctx.runId, 'cap');
}, 300_000);
afterAll(() => clearLadderJobs(ctx));

describe('the decision log of a published cap or full-allocation run (#523 I)', () => {
	it('gives a viewer kept from the volumes no per-farm figures of it in the History, but the count', async () => {
		const subjects = await published(ctx.viewer);
		const cap = subjects.get(ctx.runId)!;
		expect(cap).toBeDefined();
		expect(cap).not.toHaveProperty('perFarm');
		expect(cap.farms).toBeGreaterThan(0);
	});

	it('withholds them for a full-allocation run too', async () => {
		await markMode(ctx.runId, 'fullAllocation');
		try {
			expect((await published(ctx.viewer)).get(ctx.runId)).not.toHaveProperty('perFarm');
		} finally {
			await markMode(ctx.runId, 'cap');
		}
	});

	it('positive control: the same viewer reads a compare-only publication’s per-farm figures', async () => {
		const ok = (await published(ctx.viewer)).get(later)!;
		expect(Array.isArray(ok.perFarm) && ok.perFarm.length).toBeGreaterThan(0);
	});

	it('positive controls: the editor reads the cap run’s figures; so does a viewer the switch lets', async () => {
		expect((await published(ctx.editor)).get(ctx.runId)!.perFarm).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: ctx.farmId })]));
		expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: true })).status).toBe(200);
		try {
			expect((await published(ctx.viewer)).get(ctx.runId)).toHaveProperty('perFarm');
		} finally {
			expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: false })).status).toBe(200);
		}
	});

	it('the restriction log carries no per-farm figures for anyone', async () => {
		const r = await ctx.viewer.call('GET', `${at}/restriction-log`);
		expect(r.status).toBe(200);
		expect(r.body.items.length).toBeGreaterThan(0);
		expect(JSON.stringify(r.body)).not.toMatch(/perFarm|suppliedM3|demandM3/);
	});

	it('a trimmed run: withheld from that viewer when the event is from before 213 or its time is unknown, kept after; the editor reads it (positive control)', async () => {
		const gone = { runId: crypto.randomUUID(), farms: 1, perFarm: [{ nodeId: ctx.farmId }] };
		const read = (userId: string, at: string | null, args = 4) =>
			withUser(userId, async (db) => {
				const sql =
					args === 4
						? `SELECT app_audit_subject($1, 'publication.published', $2::jsonb, $3::timestamptz) AS s`
						: `SELECT app_audit_subject($1, 'publication.published', $2::jsonb) AS s`;
				const { rows } = await db.query<{ s: Record<string, unknown> }>(sql, args === 4 ? [ctx.projectId, JSON.stringify(gone), at] : [ctx.projectId, JSON.stringify(gone)]);
				return rows[0]!.s;
			});
		expect(await read(ctx.viewer.id, '2000-01-01T00:00:00Z')).not.toHaveProperty('perFarm');
		expect(await read(ctx.viewer.id, null)).not.toHaveProperty('perFarm');
		// The three-argument form the code before 365 calls: no time, withheld.
		expect(await read(ctx.viewer.id, null, 3)).not.toHaveProperty('perFarm');
		expect(await read(ctx.viewer.id, '2999-01-01T00:00:00Z')).toHaveProperty('perFarm');
		expect(await read(ctx.editor.id, '2000-01-01T00:00:00Z')).toHaveProperty('perFarm');
		expect((await read(ctx.viewer.id, '2000-01-01T00:00:00Z')).farms).toBe(1);
	});

	it('the helper answers nothing to someone who isn’t a viewer of the project', async () => {
		const ans = await withUser(ctx.farmer.id, async (db) =>
			(await db.query<{ b: boolean }>(`SELECT app_audit_run_held_to_volumes($1, $2::jsonb, NULL) AS b`, [ctx.projectId, JSON.stringify({ runId: ctx.runId })])).rows[0]!.b
		);
		expect(ans).toBe(false);
	});
});
