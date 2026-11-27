// The crop supply table's pure rules (engine ≥ 1.73.0, issue #408, docs/model.md
// §2.7k, ./cropSupply.ts): how a stored table is read (cropSharesOf), which
// other unit's dam a remote share may draw on (planRemoteSupply), what the API
// refuses (cropSupplyIssues, through ../modelRules.ts), and the readers views
// use (cropDamShareOf, cropRiverShareOf, plannedRemoteLegs), which must agree
// with what runModel plans. run.cropSupply.test.ts covers the daily water.
import { describe, expect, it } from 'vitest';
import type { NetworkNode, Transfer } from '../project';
import { runModelWithoutChecks } from '../run';
import { randomInput } from '../testing/fuzz';
import { cropDamShareOf, cropRiverShareOf, cropSharesOf, cropSupplyIssues, plannedRemoteLegs, planRemoteSupply, REMOTE_SERIES, SHARE_SUM_TOLERANCE } from './cropSupply';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const table = (dam: number | null, river: number | null, remote: number | null, over: Partial<NetworkNode> = {}): Partial<NetworkNode> => ({
	cropShareDam: dam,
	cropShareRiver: river,
	cropShareRemote: remote,
	...over
});

const read = (n: NetworkNode) => {
	const warnings: string[] = [];
	return { ...cropSharesOf(n, warnings), warnings };
};

const issues = (nodes: NetworkNode[], offtakes: { fromNodeId: string; toNodeId: string }[] = []) => {
	const keys: string[] = [];
	cropSupplyIssues(nodes, offtakes, (k) => keys.push(k));
	return keys;
};

describe('cropSharesOf', () => {
	it('reads no table as none: the crops take their water source', () => {
		expect(read(node('A', 'farm', null))).toEqual({ warnings: [] });
		expect(read(node('A', 'farm', null, table(null, null, null)))).toEqual({ warnings: [] });
	});

	it('runs a table all on one of the unit’s own sources as that water source, and a split as shares', () => {
		expect(read(node('A', 'farm', null, table(1, 0, null)))).toEqual({ source: 'dam', warnings: [] });
		expect(read(node('A', 'farm', null, table(0, 1, 0)))).toEqual({ source: 'river', warnings: [] });
		// All on another unit's dam is not one of the unit's own sources: it stays a table.
		expect(read(node('A', 'farm', null, table(0, 0, 1)))).toEqual({ shares: { dam: 0, river: 0, remote: 1 }, warnings: [] });
		expect(read(node('A', 'farm', null, table(0.25, 0.5, 0.25)))).toEqual({ shares: { dam: 0.25, river: 0.5, remote: 0.25 }, warnings: [] });
	});

	it('ignores a table on a node that isn’t a unit, with a warning', () => {
		for (const kind of ['user', 'gauge'] as const) {
			const r = read(node('X', kind, null, table(0.5, 0.5, 0)));
			expect(r.shares).toBeUndefined();
			expect(r.source).toBeUndefined();
			expect(r.warnings).toHaveLength(1);
			expect(r.warnings[0]).toContain('only a unit');
		}
	});

	it('takes a share outside [0, 1] or not a number as 0, with a warning naming it', () => {
		const r = read(node('A', 'farm', null, table(1.5, 0.5, 0.5)));
		expect(r.shares).toEqual({ dam: 0, river: 0.5, remote: 0.5 });
		expect(r.warnings.some((w) => w.includes('from the dam 1.5'))).toBe(true);
		expect(read(node('A', 'farm', null, table(Number.NaN, 1, null)))).toMatchObject({ source: 'river' });
		expect(read(node('A', 'farm', null, table(-0.1, 1, null))).warnings).toHaveLength(1);
	});

	it('scales shares that don’t add up to 100 % with a warning, and runs an empty table as none', () => {
		const r = read(node('A', 'farm', null, table(0.6, 0.6, 0)));
		expect(r.shares!.dam).toBeCloseTo(0.5, 12);
		expect(r.shares!.river).toBeCloseTo(0.5, 12);
		expect(r.warnings.some((w) => w.includes('add up to 120 %'))).toBe(true);
		// Within the tolerance is 100 %: no warning, nothing scaled.
		expect(read(node('A', 'farm', null, table(0.5, 0.5 + SHARE_SUM_TOLERANCE / 2, 0)))).toMatchObject({ warnings: [] });
		const none = read(node('A', 'farm', null, table(0, 0, 0)));
		expect(none.shares).toBeUndefined();
		expect(none.source).toBeUndefined();
		expect(none.warnings[0]).toContain('gives no source a share');
	});

	it('always gives shares in [0, 1] that add up to 1, whatever is stored', () => {
		const values = [null, 0, 0.1, 0.5, 1, 1.5, -1, Number.NaN];
		for (const d of values)
			for (const r of values)
				for (const x of values) {
					const t = read(node('A', 'farm', null, table(d, r, x)));
					if (!t.shares) continue;
					const { dam, river, remote } = t.shares;
					for (const v of [dam, river, remote]) expect(v >= 0 && v <= 1, `${d},${r},${x}`).toBe(true);
					expect(dam + river + remote, `${d},${r},${x}`).toBeCloseTo(1, 9);
				}
	});
});

describe('planRemoteSupply', () => {
	const dam = { damCapacityM3: 10_000 };
	const plan = (nodes: NetworkNode[], links: { from: number; to: number }[] = []) => {
		const warnings: string[] = [];
		const out = planRemoteSupply(
			nodes,
			nodes.map((n) => cropSharesOf(n, [])?.shares),
			links,
			warnings
		);
		return { out, warnings };
	};

	it('plans a remote share on another unit’s dam upstream or on another branch, held to the pipe', () => {
		// G ← A ← B: A's crops draw on B's dam, upstream of A.
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', table(0.5, 0, 0.5, { cropRemoteNodeId: 'B', cropRemoteCapM3Day: 250 })), node('B', 'farm', 'A', dam)];
		const { out, warnings } = plan(nodes);
		expect(out[1]).toEqual({ from: 2, share: 0.5, capM3Day: 250, rank: 0 });
		expect(warnings).toEqual([]);
		// Another branch: G ← A and G ← B.
		nodes[2]!.downstreamNodeId = 'G';
		expect(plan(nodes).out[1]).toMatchObject({ from: 2 });
	});

	it('supplies nothing, with a warning, from a unit that doesn’t exist, isn’t another unit or has no dam', () => {
		const cases: [Partial<NetworkNode>, NetworkNode, string][] = [
			[{ cropRemoteNodeId: 'nope' }, node('B', 'farm', 'G', dam), 'names no unit that exists'],
			[{ cropRemoteNodeId: null }, node('B', 'farm', 'G', dam), 'names no unit that exists'],
			[{ cropRemoteNodeId: 'A' }, node('B', 'farm', 'G', dam), 'is not another unit'],
			[{ cropRemoteNodeId: 'B' }, node('B', 'user', 'G', dam), 'is not another unit'],
			[{ cropRemoteNodeId: 'B' }, node('B', 'farm', 'G'), 'has no dam']
		];
		for (const [over, b, why] of cases) {
			const { out, warnings } = plan([node('G', 'gauge', null), node('A', 'farm', 'G', table(0, 0, 1, over)), b]);
			expect(out[1], why).toBeUndefined();
			expect(warnings.some((w) => w.includes(why)), why).toBe(true);
		}
	});

	it('refuses a dam the unit drains into: along the river, a river off-take, or a remote supply accepted before it', () => {
		// Along the river: A drains into B.
		let r = plan([node('G', 'gauge', null), node('B', 'farm', 'G', dam), node('A', 'farm', 'B', table(0, 0, 1, { cropRemoteNodeId: 'B' }))]);
		expect(r.out[2]).toBeUndefined();
		expect(r.warnings.some((w) => w.includes('drains into "B"'))).toBe(true);
		// Along an off-take from A to B, on separate branches.
		const branches = () => [node('G', 'gauge', null), node('A', 'farm', 'G', { ...dam, ...table(0, 0, 1, { cropRemoteNodeId: 'B' }) }), node('B', 'farm', 'G', { ...dam, ...table(0, 0, 1, { cropRemoteNodeId: 'A' }) })];
		r = plan(branches(), [{ from: 1, to: 2 }]);
		expect(r.out[1]).toBeUndefined();
		// Each draws on the other: the first in id order (A on B) is planned, then B on A would need A's day first.
		r = plan(branches());
		expect(r.out[1]).toMatchObject({ from: 2, rank: 0 });
		expect(r.out[2]).toBeUndefined();
		expect(r.warnings.some((w) => w.includes('"B" drains into "A"'))).toBe(true);
	});

	it('reads the pipe: none and a bad size run as no limit with a warning, 0 as nothing', () => {
		const pipe = (cap: number | null | undefined) =>
			plan([node('G', 'gauge', null), node('A', 'farm', 'G', table(0, 0, 1, { cropRemoteNodeId: 'B', cropRemoteCapM3Day: cap })), node('B', 'farm', 'G', dam)]);
		expect(pipe(0)).toMatchObject({ out: [undefined, { capM3Day: 0 }, undefined], warnings: [] });
		for (const cap of [null, undefined]) {
			const r = pipe(cap);
			expect(r.out[1]!.capM3Day).toBe(Infinity);
			expect(r.warnings.some((w) => w.includes('no pipe capacity'))).toBe(true);
		}
		for (const cap of [-1, Number.NaN, Infinity]) {
			const r = pipe(cap);
			expect(r.out[1]!.capM3Day, String(cap)).toBe(Infinity);
			expect(r.warnings.some((w) => w.includes('not a size ≥ 0'))).toBe(true);
		}
	});

	it('ranks the remote supplies in the receiving units’ id order, however the nodes are listed', () => {
		const make = () => [
			node('G', 'gauge', null),
			node('S', 'farm', 'G', dam),
			node('C', 'farm', 'G', table(0, 0, 1, { cropRemoteNodeId: 'S', cropRemoteCapM3Day: 1 })),
			node('A', 'farm', 'G', table(0, 0, 1, { cropRemoteNodeId: 'S', cropRemoteCapM3Day: 1 })),
			node('B', 'farm', 'G', table(0, 0, 1, { cropRemoteNodeId: 'S', cropRemoteCapM3Day: 1 }))
		];
		const rankById = (nodes: NetworkNode[]) => Object.fromEntries(plan(nodes).out.flatMap((x, i) => (x ? [[nodes[i]!.id, x.rank]] : [])));
		const want = { A: 0, B: 1, C: 2 };
		expect(rankById(make())).toEqual(want);
		expect(rankById(make().reverse())).toEqual(want);
	});
});

describe('cropSupplyIssues', () => {
	const dam = { damCapacityM3: 10_000 };
	const withA = (a: Partial<NetworkNode>, b: NetworkNode = node('B', 'farm', 'G', dam)) => issues([node('G', 'gauge', null), node('A', 'farm', 'G', a), b]);

	it('passes a sound table, and a node without one', () => {
		expect(withA({})).toEqual([]);
		expect(withA(table(0.25, 0.25, 0.5, { cropRemoteNodeId: 'B', cropRemoteCapM3Day: 100 }))).toEqual([]);
		expect(withA(table(1, 0, null))).toEqual([]);
		// No pipe capacity is allowed (the run warns that only storage limits it).
		expect(withA(table(0, 0, 1, { cropRemoteNodeId: 'B', cropRemoteCapM3Day: null }))).toEqual([]);
	});

	it('refuses each thing the run would only warn about, under its own key', () => {
		expect(issues([node('U', 'user', null, table(1, 0, 0))])).toEqual(['cropShareKind:U']);
		expect(withA(table(1.5, 0, 0))).toEqual(['cropShareRange:A']);
		expect(withA(table(0.6, 0.6, 0))).toEqual(['cropShareSum:A']);
		expect(withA(table(0, 0, 0))).toEqual(['cropShareSum:A']);
		expect(withA(table(0.5, 0, 0.5, { cropRemoteNodeId: 'B', cropRemoteCapM3Day: -5 }))).toEqual(['cropRemoteCap:A']);
		expect(withA(table(0.5, 0, 0.5, { cropRemoteNodeId: 'nope' }))).toEqual(['cropRemoteNode:A']);
		expect(withA(table(0.5, 0, 0.5, { cropRemoteNodeId: 'A' }))).toEqual(['cropRemoteNode:A']);
		expect(withA(table(0.5, 0, 0.5, { cropRemoteNodeId: 'B' }), node('B', 'farm', 'G'))).toEqual(['cropRemoteDam:A']);
		expect(issues([node('G', 'gauge', null), node('B', 'farm', 'G', dam), node('A', 'farm', 'B', table(0.5, 0, 0.5, { cropRemoteNodeId: 'B' }))])).toEqual(['cropRemoteLoop:A']);
	});

	it('follows the river off-takes and the remote shares named before, as the run does', () => {
		const branches = () => [node('G', 'gauge', null), node('A', 'farm', 'G', { ...dam, ...table(0, 0, 1, { cropRemoteNodeId: 'B' }) }), node('B', 'farm', 'G', { ...dam, ...table(0, 0, 1, { cropRemoteNodeId: 'A' }) })];
		expect(issues(branches(), [{ fromNodeId: 'A', toNodeId: 'B' }])).toEqual(['cropRemoteLoop:A']);
		expect(issues(branches())).toEqual(['cropRemoteLoop:B']);
	});

	it('refuses a table exactly when the run reads it with a warning other than the pipe’s', () => {
		// Each refusal above, and each sound table, against what cropSharesOf and planRemoteSupply say of it.
		const values = [null, 0, 0.5, 1, 1.5];
		for (const d of values)
			for (const x of values)
				for (const remoteId of ['B', 'A', 'nope']) {
					const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', table(d, 0.5, x, { cropRemoteNodeId: remoteId, cropRemoteCapM3Day: 10 })), node('B', 'farm', 'G', dam)];
					const warnings: string[] = [];
					const shares = nodes.map((n) => cropSharesOf(n, warnings).shares);
					planRemoteSupply(nodes, shares, [], warnings);
					const label = `${d},${x},${remoteId}`;
					// cropSharesOf scales a sum it can read, so a table the API refuses for its sum is still run; it warns either way.
					expect(issues(nodes).length > 0, `${label}: ${warnings.join(' | ')}`).toBe(warnings.length > 0);
				}
	});
});

describe('the readers views use', () => {
	it('cropDamShareOf and cropRiverShareOf read the table, else the water source', () => {
		expect([cropDamShareOf(node('A', 'farm', null)), cropRiverShareOf(node('A', 'farm', null))]).toEqual([1, 0]);
		expect([cropDamShareOf(node('A', 'farm', null, { cropWaterSource: 'river' })), cropRiverShareOf(node('A', 'farm', null, { cropWaterSource: 'river' }))]).toEqual([0, 1]);
		// A table replaces the water source.
		const t = node('A', 'farm', null, { cropWaterSource: 'river', ...table(0.25, 0.5, 0.25, { cropRemoteNodeId: 'B' }) });
		expect([cropDamShareOf(t), cropRiverShareOf(t)]).toEqual([0.25, 0.5]);
		expect(cropRiverShareOf(node('A', 'farm', null, { cropWaterSource: 'dam', ...table(0, 1, 0) }))).toBe(1);
		expect(cropRiverShareOf(node('U', 'user', null, { cropWaterSource: 'river' }))).toBe(0);
	});

	it('plannedRemoteLegs skips a river off-take the run skips: one whose destination drains into its source', () => {
		// G ← A ← B: an off-take A → B can't run (B drains into A), so it is no link, and A's crops may draw on B's dam.
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', table(0.5, 0, 0.5, { cropRemoteNodeId: 'B', cropRemoteCapM3Day: 10 })), node('B', 'farm', 'A', { damCapacityM3: 10_000 })];
		const offtake: Transfer = {
			id: 'o1',
			fromNodeId: 'A',
			toNodeId: 'B',
			source: 'river',
			months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			maxRateM3s: 0.01,
			dailyCapM3: null,
			minStoragePct: 0,
			enabled: true,
			priority: 0
		} as Transfer;
		expect(plannedRemoteLegs(nodes, [offtake])).toEqual([{ from: 2, to: 1 }]);
		// Control: on separate branches the run accepts A → B, and that link does block the leg (A would feed B's dam first).
		nodes[2]!.downstreamNodeId = 'G';
		expect(plannedRemoteLegs(nodes, [offtake])).toEqual([]);
		expect(plannedRemoteLegs(nodes, [])).toEqual([{ from: 2, to: 1 }]);
	});

	it('plannedRemoteLegs names exactly the units runModel gives a remote supply series, on random networks', () => {
		let withLegs = 0;
		for (let seed = 1; seed <= 400; seed++) {
			const input = randomInput(seed);
			if (!input.model.nodes.some((n) => (n.cropShareRemote ?? 0) > 0)) continue;
			const out = runModelWithoutChecks(input);
			const ran = new Set(out.series.filter((s) => s.key === REMOTE_SERIES.in.key).map((s) => s.nodeId));
			const legs = plannedRemoteLegs(input.model.nodes, input.model.transfers);
			const planned = new Set(legs.map((l) => input.model.nodes[l.to]!.id));
			expect([...planned].sort(), `seed ${seed}`).toEqual([...ran].sort());
			if (legs.length) withLegs++;
		}
		// The property is about something: some seeds plan a remote supply.
		expect(withLegs).toBeGreaterThan(3);
	});
});
