// Structural rules of a model input that a scenario op must not break: the
// model's save rules (modelRules.ts, the one home the backend's modelProblems
// also calls, so a scenario can only produce a model a save would accept),
// plus the catchment area and the settings windows. applyScenario rejects an op that
// introduces an issue the input didn't already have, so a base that already
// carries one (an old project, a fuzz input) can still take unrelated ops.
//
// Keys are id-based so renaming a node doesn't turn an existing issue into a
// "new" one; texts are for people.
import type { DroughtRestrictionRule, ModelInput } from '../project';
import { droughtRestrictionIssues, droughtRestrictionNodeIssues } from '../network/restriction';
import { modelRuleIssues } from '../modelRules';
import { resolveCatchmentAreaKm2 } from '../runoff/area';

export type StructureIssues = Map<string, string>;

export function structureIssues(input: ModelInput): StructureIssues {
	const out: StructureIssues = modelRuleIssues(input.model);
	const add = (key: string, text: string) => out.set(key, text);
	const m = input.model;

	// Rain needs land to fall on: runModel refuses a catchment of 0 km² (runoff/area.ts).
	const s = input.settings as Record<string, unknown>;
	const cal = (s.calibration ?? {}) as { catchmentAreaKm2?: number | null };
	if (m.nodes.length && !(resolveCatchmentAreaKm2({ catchmentAreaKm2: cal.catchmentAreaKm2 ?? null }, input) > 0))
		add('area', 'the catchment has no area left: no unit has land and calibration.catchmentAreaKm2 is not set');

	// Flow shares over 100 % (engines up to 1.104.x, the specific shares) can't happen from 1.105.0: each unit's natural
	// MAR share adds up to 1 by construction (issue #616, network/ewrSplit.ts).

	// The drought restriction's units, dams and EWR site (engine ≥ 1.54.0): the Settings form blocks a save naming one
	// the network hasn't got, and the run leaves it out with only a warning. So removing (or emptying) the one dam the
	// rule reads turned the restriction off for every unit, scored as the op's effect. Keyed per id, so an issue the
	// base already carries isn't new. A malformed rule is the run's to refuse, not checked here.
	const rule = s.droughtRestriction;
	if (rule && typeof rule === 'object' && !droughtRestrictionIssues(rule).length) {
		const r = rule as DroughtRestrictionRule;
		const one = (key: string, part: Partial<DroughtRestrictionRule>) => {
			for (const i of droughtRestrictionNodeIssues({ ...r, damNodeIds: [], nodeIds: [], ewrTrigger: undefined, ...part }, m.nodes)) add(key, `drought restriction rule: ${i.message}`);
		};
		if (r.basis === 'dams') for (const id of r.damNodeIds ?? []) one(`restrictionDam:${id}`, { damNodeIds: [id] });
		for (const id of r.nodeIds ?? []) one(`restrictionUnit:${id}`, { nodeIds: [id] });
		if (typeof r.ewrTrigger?.siteNodeId === 'string') one(`restrictionSite:${r.ewrTrigger.siteNodeId}`, { ewrTrigger: r.ewrTrigger });
	}

	// Windows: a start after its end.
	for (const [a, b, label] of [
		['simulationStart', 'simulationEnd', 'simulation'],
		['reportStart', 'reportEnd', 'reporting'],
		['calibrationStart', 'calibrationEnd', 'calibration']
	] as const) {
		const x = s[a];
		const y = s[b];
		if (typeof x === 'string' && typeof y === 'string' && x > y) add(`window:${label}`, `the ${label} window starts (${x}) after it ends (${y})`);
	}
	// Each ticked calibration location's own window (issue #659: a scenario's calibration window is the headline gauge's row).
	for (const z of Array.isArray(s.calibrationZones) ? (s.calibrationZones as { nodeId?: unknown; enabled?: unknown; calibrationStart?: unknown; calibrationEnd?: unknown }[]) : []) {
		if (!z || z.enabled !== true) continue;
		const x = z.calibrationStart;
		const y = z.calibrationEnd;
		if (typeof x === 'string' && typeof y === 'string' && x > y) {
			const name = m.nodes.find((n) => n.id === z.nodeId)?.name ?? String(z.nodeId);
			add(`window:calibration:${String(z.nodeId)}`, `the calibration window at ${name} starts (${x}) after it ends (${y})`);
		}
	}
	return out;
}
