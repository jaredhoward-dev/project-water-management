// A run Runs & results started that is still going (issue #923). The project page keeps it, as it keeps its own
// `rerunning`, so leaving the tab and coming back finds the run still going: Run model stays disabled and the
// progress line and its seconds carry on, and the finished run is opened only if the tab is open then.
import type { Run, RunMeta } from '#lib/api/index.js';

/** What api.runs.create answers. */
export interface RunCreated {
	run: Run;
	removedRunIds: string[];
}

/** A run in flight: which project, when it started (the progress line's seconds), and the request's answer. */
export interface RunInFlight {
	projectId: string;
	startedAt: number;
	done: Promise<RunCreated>;
}

/**
 * The runs list with a new run at the top: its summary left out (the list holds metadata), any older copy of it
 * dropped, and the oldest runs the server trimmed to stay within its cap gone. Applying it twice gives the same
 * list, so the tab that started the run and the one that came back to it can both take it.
 */
export function withCreatedRun(runs: readonly RunMeta[], created: RunCreated): RunMeta[] {
	const { summary: _summary, ...meta } = created.run;
	return [meta, ...runs.filter((x) => x.id !== meta.id && !created.removedRunIds.includes(x.id))];
}

/** Whole seconds since a run started, never below 0 (a clock that steps back). */
export function elapsedSeconds(startedAt: number, now: number): number {
	return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** The run in flight the project's Runs tab should show: only one started on this project. */
export function inFlightFor(flight: RunInFlight | null, projectId: string): RunInFlight | null {
	return flight && flight.projectId === projectId ? flight : null;
}
