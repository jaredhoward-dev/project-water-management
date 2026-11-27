// Cumulative impact (ER-36, scenarios.md § Engine: combineScenarios and
// cumulativeImpact) on random networks:
//  - one scenario: the combined run is that scenario alone, so every row's
//    interaction is exactly 0 and its combined change its single change;
//  - two disjoint scenarios: the report doesn't depend on the order they are
//    given (sum of singles and combined change within float noise, the
//    singles' columns swapped);
//  - when the two scenarios' effects are independent (each changes only its
//    own headwater farm's runoff, no crops, no dam, both drain straight to
//    the outlet gauge), the outlet-flow interaction is 0 and the combined change the sum.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { randomOps } from '../testing/scenarioFuzz';
import { combineScenarios } from './combine';
import { cumulativeImpact, type CumulativeRun } from './cumulative';
import { applyScenario } from './overrides';
import type { ScenarioOp } from './ops';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.SCENARIO_FUZZ_CASES ?? 60);
const GEN = { maxNodes: 8, maxDays: 300, allocationModes: false };

const runOf = (input: ModelInput): CumulativeRun | null => {
	try {
		const o = runModel(input);
		return { summary: o.summary, startDate: o.startDate, endDate: o.endDate };
	} catch {
		return null;
	}
};

function clean(base: ModelInput, ops: ScenarioOp[]): ScenarioOp[] | null {
	const kept = applyScenario(base, ops).applied.map((a) => a.op);
	return kept.length && !applyScenario(base, kept).problems.length ? kept : null;
}

const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));

describe('cumulativeImpact on random networks', () => {
	it(`one scenario: every interaction is exactly 0 (${CASES} cases)`, () => {
		let n = 0;
		for (let seed = 1; seed <= CASES; seed++) {
			const base = randomInput(seed, GEN);
			const ops = clean(base, randomOps(base, seed, 3));
			if (!ops) continue;
			const b = runOf(base);
			const one = runOf(applyScenario(base, ops).input);
			const comb = combineScenarios(base, [{ id: 's', ops }]);
			if (!b || !one || !comb.input) continue;
			const c = runOf(comb.input)!;
			const r = cumulativeImpact(b, [{ id: 's', name: 'S', ...one }], c);
			for (const row of r.rows) {
				expect(row.combinedChange, `seed ${seed} ${row.metric}`).toBe(row.singleChanges[0]);
				if (row.interaction !== null) expect(row.interaction, `seed ${seed} ${row.metric}`).toBe(0);
			}
			n++;
		}
		expect(n).toBeGreaterThan(CASES / 4);
	}, 300_000);

	it(`two disjoint scenarios: the report is the same in either order (${CASES} cases)`, () => {
		let n = 0;
		for (let seed = 1; seed <= CASES; seed++) {
			const base = randomInput(seed, GEN);
			const a = clean(base, randomOps(base, seed, 2));
			const bOps = clean(base, randomOps(base, seed + 1_000_000, 2));
			if (!a || !bOps) continue;
			const ab = combineScenarios(base, [{ id: 'a', ops: a }, { id: 'b', ops: bOps }]);
			const ba = combineScenarios(base, [{ id: 'b', ops: bOps }, { id: 'a', ops: a }]);
			if (!ab.input || !ba.input) continue;
			const base0 = runOf(base);
			const ra = runOf(applyScenario(base, a).input);
			const rb = runOf(applyScenario(base, bOps).input);
			const cab = runOf(ab.input);
			const cba = runOf(ba.input);
			if (!base0 || !ra || !rb || !cab || !cba) continue;
			const x = cumulativeImpact(base0, [{ id: 'a', name: 'A', ...ra }, { id: 'b', name: 'B', ...rb }], cab);
			const y = cumulativeImpact(base0, [{ id: 'b', name: 'B', ...rb }, { id: 'a', name: 'A', ...ra }], cba);
			expect(x.rows.map((r) => `${r.metric}|${r.siteNodeId}`)).toEqual(y.rows.map((r) => `${r.metric}|${r.siteNodeId}`));
			x.rows.forEach((r, i) => {
				const s = y.rows[i]!;
				const why = `seed ${seed} ${r.metric} ${r.siteNodeId}`;
				expect(close(r.sumOfSingles, s.sumOfSingles), why).toBe(true);
				expect(close(r.combinedChange, s.combinedChange), why).toBe(true);
				expect(close(r.interaction, s.interaction), why).toBe(true);
				expect(r.singleChanges).toEqual([...s.singleChanges].reverse());
			});
			n++;
		}
		expect(n).toBeGreaterThan(CASES / 6);
	}, 300_000);

	it('independent effects add up: two headwater units each scaled alone, the outlet flow’s interaction is 0', () => {
		const base = randomInput(3, GEN);
		const unit = (id: string, kind: 'farm' | 'gauge', downstreamNodeId: string | null, areaKm2: number): NetworkNode => ({ ...base.model.nodes[0]!, id, name: id, kind, downstreamNodeId, areaKm2, damCapacityM3: 0, pctRunoffToDam: 0, pctUpstreamToDam: 0, sortOrder: 0 });
		const input: ModelInput = {
			...base,
			model: { ...base.model, nodes: [unit('G', 'gauge', null, 0), unit('A', 'farm', 'G', 20), unit('B', 'farm', 'G', 30)], cropAreas: [], transfers: [], landCover: [], boreholes: [], demandObjects: [], allocations: [], ewrRules: [] } as ModelInput['model']
		};
		const b = runOf(input)!;
		const opsA: ScenarioOp[] = [{ op: 'node.set', nodeId: 'A', field: 'areaKm2', value: 35 }];
		const opsB: ScenarioOp[] = [{ op: 'node.set', nodeId: 'B', field: 'areaKm2', value: 12 }];
		const comb = combineScenarios(input, [{ id: 'a', ops: opsA }, { id: 'b', ops: opsB }]);
		expect(comb.conflicts).toEqual([]);
		expect(comb.problems).toEqual([]);
		const r = cumulativeImpact(
			b,
			[
				{ id: 'a', name: 'A', ...runOf(applyScenario(input, opsA).input)! },
				{ id: 'b', name: 'B', ...runOf(applyScenario(input, opsB).input)! }
			],
			runOf(comb.input!)!
		);
		const row = r.rows.find((x) => x.metric === 'outlet_flow')!;
		expect(row.singleChanges.every((v) => v !== null && v !== 0)).toBe(true);
		expect(Math.abs(row.interaction!)).toBeLessThanOrEqual(1e-9 * Math.abs(row.baseline!));
		expect(row.combinedChange).toBeCloseTo(row.sumOfSingles!, 6);
	});
});
