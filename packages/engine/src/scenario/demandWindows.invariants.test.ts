// Dated demand.scale windows (engine ≥ 1.82.0, refusal of a window that changes
// no day ≥ 1.119.0; docs/scenarios.md § Demand scaling) on random networks:
//  - a window over the whole run, every month, is the undated scaling;
//  - one window split in two at any day is the same run as the window whole;
//  - a window of factor 1 is the base run, to the bit;
//  - a window wholly outside the rain series is refused; one only on a blank
//    tail of the rain past the run's last day is accepted (the check reads the
//    series' span, an outer bound of the run's days) and changes nothing.
// Daily series are compared within float noise of the run's largest value
// (the dated factor and the undated one multiply at different points).
// Soak: SCENARIO_FUZZ_CASES=600 pnpm -C packages/engine exec vitest run src/scenario/demandWindows.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { fromEpochDay } from '../calendar';
import { prepareRun } from '../prepare';
import type { ModelInput, ModelOutput } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { sameOutput } from '../testing/invariants';
import { applyScenario } from './overrides';
import type { ScenarioOp } from './ops';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.SCENARIO_FUZZ_CASES ?? 60);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
const GEN = { maxNodes: 8, maxDays: 400, allocationModes: false };

/** The first daily series (and day) where two runs differ by more than float noise, or null. */
function seriesDifference(a: ModelOutput, b: ModelOutput): string | null {
	let scale = 1;
	for (const o of [a, b]) for (const s of o.series) for (const v of s.values) if (Number.isFinite(v)) scale = Math.max(scale, Math.abs(v));
	const tol = scale * 1e-9;
	const key = (s: ModelOutput['series'][number]) => `${s.nodeId ?? '-'}|${s.key}`;
	const bs = new Map(b.series.map((s) => [key(s), s.values]));
	if (a.series.length !== b.series.length) return `series count ${a.series.length} vs ${b.series.length}`;
	for (const s of a.series) {
		const y = bs.get(key(s));
		if (!y) return `series ${key(s)} missing`;
		for (let t = 0; t < s.values.length; t++) {
			const x = s.values[t]!;
			const z = y[t]!;
			if (Number.isNaN(x) && Number.isNaN(z)) continue;
			if (!(Math.abs(x - z) <= tol)) return `series ${key(s)} day ${t}: ${x} vs ${z}`;
		}
	}
	return null;
}

/** A random base with a farm (or other user) to scale and no undated factor start, plus its run window. */
function caseOf(seed: number): { base: ModelInput; category: 'farm' | 'user'; start: number; days: number } | null {
	const base = randomInput(seed, GEN);
	const category = new Rng(seed ^ 0x51ed).bool(0.7) ? 'farm' : 'user';
	if (!base.model.nodes.some((n) => n.kind === category)) return null;
	base.settings = { ...base.settings, demandFactorFrom: null };
	try {
		const run = prepareRun(base);
		return { base, category, start: run.start, days: run.days };
	} catch {
		return null;
	}
}

function runOf(base: ModelInput, ops: ScenarioOp[]): { out: ModelOutput | null; error: string | null; problems: string[] } {
	const r = applyScenario(base, ops);
	if (r.problems.length) return { out: null, error: null, problems: r.problems };
	try {
		return { out: runModel(r.input), error: null, problems: [] };
	} catch (e) {
		return { out: null, error: (e as Error).message, problems: [] };
	}
}

describe('dated demand.scale windows on random networks', () => {
	it(`a window over the whole run is the undated scaling, and a split window the window whole (${CASES} cases)`, () => {
		const failures: string[] = [];
		let compared = 0;
		for (let seed = SEED0; seed < SEED0 + CASES && failures.length < 3; seed++) {
			const c = caseOf(seed);
			if (!c) continue;
			const g = new Rng(seed ^ 0x7a11);
			const factor = g.pick([0, 0.5, 0.8, 1.3, 2, g.float(0, 2)]);
			const from = fromEpochDay(c.start);
			const to = fromEpochDay(c.start + c.days - 1);
			const undated = runOf(c.base, [{ op: 'demand.scale', category: c.category, factor }]);
			const whole = runOf(c.base, [{ op: 'demand.scale', category: c.category, factor, from, to }]);
			if (undated.problems.length || whole.problems.length) {
				failures.push(`seed ${seed}: refused: ${[...undated.problems, ...whole.problems].join('; ')}`);
				continue;
			}
			if (undated.error || whole.error) {
				if (undated.error !== whole.error) failures.push(`seed ${seed}: undated threw ${undated.error}, dated ${whole.error}`);
				continue;
			}
			const d = seriesDifference(undated.out!, whole.out!);
			if (d) failures.push(`seed ${seed} (factor ${factor}, ${c.category}): whole-run window vs undated: ${d}`);
			// Split at any day inside the run: [start, cut] and [cut + 1, end].
			if (c.days >= 2) {
				const cut = c.start + g.int(0, c.days - 2);
				const split = runOf(c.base, [
					{ op: 'demand.scale', category: c.category, factor, from, to: fromEpochDay(cut) },
					{ op: 'demand.scale', category: c.category, factor, from: fromEpochDay(cut + 1), to }
				]);
				if (split.problems.length) failures.push(`seed ${seed}: split refused: ${split.problems.join('; ')}`);
				else if (split.out) {
					const e = seriesDifference(whole.out!, split.out);
					if (e) failures.push(`seed ${seed} (cut ${fromEpochDay(cut)}): split window vs whole: ${e}`);
				}
			}
			compared++;
		}
		expect(failures.join('\n')).toBe('');
		expect(compared).toBeGreaterThan(CASES / 3);
	}, 300_000);

	it(`a window of factor 1 is the base run to the bit, and one outside the run is refused (${CASES} cases)`, () => {
		let compared = 0;
		let tails = 0;
		for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
			const c = caseOf(seed);
			if (!c) continue;
			const g = new Rng(seed ^ 0x0ddba11);
			const a = c.start + g.int(0, c.days - 1);
			const b = Math.min(c.start + c.days - 1, a + g.int(0, 200));
			let base: ModelOutput;
			try {
				base = runModel(c.base);
			} catch {
				continue;
			}
			const one = runOf(c.base, [{ op: 'demand.scale', category: c.category, factor: 1, from: fromEpochDay(a), to: fromEpochDay(b) }]);
			expect(one.problems, `seed ${seed}`).toEqual([]);
			expect(sameOutput(base, one.out!), `seed ${seed}`).toBe(true);
			// Wholly outside every rain series (the outer bound the check reads, runDayBounds): refused.
			const far = (a0: number, a1: number) => runOf(c.base, [{ op: 'demand.scale', category: c.category, factor: 0.5, from: fromEpochDay(a0), to: fromEpochDay(a1) }]);
			expect(far(c.start - 3000, c.start - 2000).problems.length, `seed ${seed}: before the run`).toBeGreaterThan(0);
			expect(far(c.start + c.days + 2000, c.start + c.days + 3000).problems.length, `seed ${seed}: after the run`).toBeGreaterThan(0);
			// Just past the run's last day: inside a blank tail of the rain (the run's end moved in to its last rained day)
			// it is accepted, and then it changes nothing; past the rain it is refused. Never a different run.
			const tail = far(c.start + c.days, c.start + c.days + 30);
			if (!tail.problems.length && tail.out) {
				expect(sameOutput(base, tail.out), `seed ${seed}: a window past the run's last day changed the run`).toBe(true);
				tails++;
			}
			compared++;
		}
		expect(compared).toBeGreaterThan(CASES / 3);
		// The blank-tail case is met at the default seeds (seed 29), so the accepted no-op is exercised.
		if (SEED0 === 1 && CASES >= 30) expect(tails).toBeGreaterThan(0);
	}, 300_000);
});
