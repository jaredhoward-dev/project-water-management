import type { RunMeta } from '#lib/api/types.js';

/** The fields of a run that say whether a scenario made it. */
export type ScenarioRunFields = Partial<Pick<RunMeta, 'fromScenario' | 'scenarioId' | 'scenarioName'>>;

/**
 * A run a scenario made (024_scenarios), also once that scenario is deleted:
 * its `scenarioId` is then null, but the run still holds the scenario's
 * changes on a base run (188_scenario_run_flag, issue #381), so it is never a
 * run of the model, a base, or the default run to show. `fromScenario` is the
 * API's answer; an older API without it still names the scenario the run
 * recorded (`scenarioName`). Never test `!run.scenarioId` for "a run of the
 * model" (scenarioRun.test.ts guards it).
 */
export function isScenarioRun(r: ScenarioRunFields): boolean {
	return r.fromScenario ?? (!!r.scenarioId || !!r.scenarioName);
}

/**
 * The scenario that made a run, to name it or link to it: null for a run of
 * the model (isScenarioRun); `id` null once the scenario is deleted (the run
 * keeps the name it recorded). The one place outside the API types that reads
 * a run's `scenarioId`.
 */
export function runScenario(r: ScenarioRunFields): { id: string | null; name: string | null } | null {
	if (!isScenarioRun(r)) return null;
	return { id: r.scenarioId ?? null, name: r.scenarioName?.trim() || null };
}

/**
 * The project's latest run, as the API's (backend runs/read.ts latestRunId):
 * the newest run of the model, never a newer scenario run or forecast run,
 * else (a project with nothing else) the newest of any. Runs arrive newest
 * first. The printable report opens on it without `?run=`, the run the
 * server's PDF and its schedules print. null with no runs.
 */
export function latestModelRun<R extends ScenarioRunFields & Pick<RunMeta, 'id' | 'trigger'>>(runs: readonly R[]): R | null {
	return runs.find((r) => !isScenarioRun(r) && r.trigger !== 'forecast') ?? runs[0] ?? null;
}
