// The Restriction log's reads, latest wins (docs/architecture.md § Stale
// responses): the first page is read on load, on another project and on Try
// again, and older pages on Show older decisions. Both go through one
// sequencer, so a slow earlier read (the first page, or an older page
// appended to it) never lands over a newer first page, which may be another
// project's.
import { api, type RestrictionDecision } from '#lib/api/index.js';
import { latestCall, type Latest } from '#lib/api/latest.js';

export type LogPage = { items: RestrictionDecision[]; next: string | null };

/** A page of the restriction log (`before` null: the newest), latest call only. */
export function restrictionLogLoader(
	read: (projectId: string, before: string | null) => Promise<LogPage> = (id, before) => api.publication.log(id, before)
): (projectId: string, before: string | null) => Promise<Latest<LogPage>> {
	return latestCall(read);
}
