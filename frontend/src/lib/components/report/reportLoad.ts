// The report page's load (routes/projects/[id]/report, docs/ui.md § Report),
// latest wins (docs/architecture.md § Stale responses): changing ?run= (or
// &against=, or the project) while a slower load is still out must never let
// that earlier run's report land under the later run's address.
import type { SeriesMeta } from '@water-management/engine';
// From client and types, not index.js, so a unit test needs no SvelteKit env module.
import { ApiError, type Api as ApiClient } from '#lib/api/client.js';
import type { Project, Run, RunCompareResponse, RunPublication, SignoffList } from '#lib/api/types.js';
import { latestCall, type Latest } from '#lib/api/latest.js';
import { parseRef } from '#lib/components/compare/picker.js';
import { loadImpactSeries, type ImpactSeries } from '#lib/components/report/impactSeries.js';
import { cachedSeries } from '#lib/components/runs/cache.js';
import { CATCHMENT_FLOW_KEYS, EWR_RULE_KEY, observedSources, type CatchmentFlows, type ObservedSources } from '#lib/components/runs/flowSeries.js';
import { latestModelRun } from '#lib/components/runs/scenarioRun.js';

export interface ReportLoadDeps {
	api: {
		projects: Pick<ApiClient['projects'], 'get'>;
		runs: Pick<ApiClient['runs'], 'list' | 'get' | 'series'>;
		series: Pick<ApiClient['series'], 'list'>;
		signoffs: Pick<ApiClient['signoffs'], 'list'>;
		publication: Pick<ApiClient['publication'], 'ofRun'>;
		compare: Pick<ApiClient['compare'], 'runs'>;
	};
	/** The report's lazy chunks (the human impacts and restriction tables, and the impact section with a baseline), in before "ready". */
	chunks: (withImpact: boolean) => Promise<unknown>;
}

/** What one load found; the page applies it only while it is the latest load. */
export type ReportLoad =
	| { status: 'no-runs' | 'no-run' | 'chunk-failed'; project: Project; series: SeriesMeta[] }
	| {
			status: 'loaded';
			project: Project;
			series: SeriesMeta[];
			run: Run;
			flows: CatchmentFlows;
			sources: ObservedSources;
			signoffs: SignoffList;
			runPub: RunPublication;
			impact: RunCompareResponse | null;
			impactSeries: ImpactSeries | null;
			impactError: string | null;
	  };

/** One load of the report: the project, then the run (`want`, else the latest model run) and everything its sections read. */
export async function loadReport(deps: ReportLoadDeps, id: string, want: string | null, against: string | null): Promise<ReportLoad> {
	const { api } = deps;
	// A non-member gets 404 on the project, like the workspace.
	const [project, list, series] = await Promise.all([
		api.projects.get(id),
		want ? null : api.runs.list(id),
		api.series.list(id).catch(() => [] as SeriesMeta[])
	]);
	// Without ?run=, the latest run of the model (never a newer scenario or forecast run), as the server's PDF and schedules print.
	const runId = want ?? (list ? latestModelRun(list)?.id : undefined);
	if (!runId) return { status: 'no-runs', project, series };
	let detail: Awaited<ReturnType<ApiClient['runs']['get']>>;
	try {
		detail = await api.runs.get(id, runId);
	} catch (e) {
		if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { status: 'no-run', project, series };
		throw e;
	}
	const have = (k: string) => detail.series.some((r) => r.key === k && r.nodeId === null);
	const againstRef = parseRef(against);
	let impactError: string | null = null;
	const [pairs, signoffs, runPub, impact, impactSeries] = await Promise.all([
		Promise.all(
			[...CATCHMENT_FLOW_KEYS, EWR_RULE_KEY].filter(([, k]) => have(k)).map(
				async ([slot, k]) => [slot, await cachedSeries(runId, k, null, () => api.runs.series(id, runId, k, null))] as const
			)
		),
		api.signoffs.list(id, runId),
		api.publication.ofRun(id, runId),
		// The impact section: a baseline that can't be compared says why in its section; the report still loads.
		against
			? api.compare.runs(against, `${id}:${runId}`).catch((e: unknown) => {
					impactError =
						e instanceof ApiError && (e.status === 404 || e.status === 400)
							? "The baseline doesn't exist any more, or its project isn't shared with you."
							: e instanceof Error
								? e.message
								: String(e);
					return null;
				})
			: null,
		// The licence-impact board's series; one that can't be read is null, and the board says so.
		againstRef ? loadImpactSeries((p, r, k) => api.runs.series(p, r, k, null), againstRef, { projectId: id, runId }) : null
	]);
	// If a chunk fails to download, only a reload can fetch it (lazy.ts), so it gets its own message, not "Try again".
	try {
		await deps.chunks(!!against);
	} catch {
		return { status: 'chunk-failed', project, series };
	}
	return {
		status: 'loaded',
		project,
		series,
		run: detail.run,
		flows: Object.fromEntries(pairs) as CatchmentFlows,
		sources: observedSources(detail.series),
		signoffs,
		runPub,
		impact,
		impactSeries,
		impactError
	};
}

/**
 * The page's loader: `{ current: false }` once a later load began (its failure too), so a slow load of
 * the previous ?run= can't overwrite the run the address now names; the latest load's failure is thrown.
 */
export function reportLoader(deps: ReportLoadDeps): (id: string, want: string | null, against: string | null) => Promise<Latest<ReportLoad>> {
	return latestCall((id: string, want: string | null, against: string | null) => loadReport(deps, id, want, against));
}
