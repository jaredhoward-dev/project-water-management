// The errata a validation statement lists (issue #103, docs/engine-errata.md).
//
// The API works out which errata apply to a run (backend errata/runs.ts, the
// run's `errata` ids) from the errata list of the backend's build. This site's
// engine carries the list of the site's own build, which can be older: web
// ships after backend (docs/deployment.md § Releasing), so between the two an
// old site would leave out errata the backend already knows. So the server's
// ids win when the run has them. Each is described from this build's
// catalogue where it knows the id, and named as recorded after this build
// where it doesn't. Without them (an older API, a run from a route that
// doesn't carry them) it falls back to the engine's own reckoning.
import { ENGINE_ERRATA, type Erratum } from '@water-management/engine';

export interface StatementErratum {
	id: string;
	/** What goes wrong; null when this build doesn't know the erratum. */
	summary: string | null;
	appliesWhen: string | null;
	fixedIn: string | null;
	/** Whether this site's build knows the erratum (else only its id is shown). */
	known: boolean;
}

const row = (e: Erratum): StatementErratum => ({ id: e.id, summary: e.summary, appliesWhen: e.appliesWhen, fixedIn: e.fixedIn, known: true });

/**
 * The rows of the statement's errata table: the run's server-provided ids
 * when present (in the server's order, unknown ones kept), else `engineErrata`
 * (the engine's validationStatement() list for the run).
 */
export function statementErrata(engineErrata: readonly Erratum[], serverIds: readonly string[] | null | undefined, catalogue: readonly Erratum[] = ENGINE_ERRATA): StatementErratum[] {
	if (!serverIds) return engineErrata.map(row);
	const byId = new Map(catalogue.map((e) => [e.id, e]));
	return [...new Set(serverIds)].map((id) => {
		const e = byId.get(id);
		return e ? row(e) : { id, summary: null, appliesWhen: null, fixedIn: null, known: false };
	});
}
