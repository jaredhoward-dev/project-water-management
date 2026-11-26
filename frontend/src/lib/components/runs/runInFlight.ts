// A run Runs & results started that is still going (issue #923). The project page keeps it, as it keeps its own
// `rerunning`, so leaving the tab and coming back finds the run still going: Run model stays disabled and the
// progress line and its seconds carry on, and the finished run is opened only if the tab is open then.
import type { Run, RunMeta } from '#lib/api/index.js';
import { runErrorText } from './runList';

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

/** A run Runs & results started failed while the person was elsewhere: the project page says so until dismissed. */
export interface RunFailure {
	projectId: string;
	text: string;
}

/**
 * Where a run started on Runs & results failed, what the project page shows (issue #923): nothing while that
 * project's Runs & results is open, since the tab says it under its run form; anywhere else (another tab of the
 * project, or another project) the failure in words (runErrorText: a gone run as RUN_GONE), for that project only.
 */
export function failureForPage(flight: RunInFlight, err: unknown, at: { projectId: string; tab: string }): RunFailure | null {
	if (at.projectId === flight.projectId && at.tab === 'runs') return null;
	return { projectId: flight.projectId, text: runErrorText(err) };
}
