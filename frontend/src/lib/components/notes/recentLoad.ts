// The Overview's recent notes, latest wins (docs/architecture.md § Stale
// responses): RecentNotes reads them again whenever the shared note counts
// change (a note added, edited or deleted in any drawer) and on Try again, so
// two reads can be out at once, and a slower earlier one must not bring back
// the list as it was before the change (a note just added missing from it).
import { api, type Note } from '#lib/api/index.js';
import { latestCall, type Latest } from '#lib/api/latest.js';

/** The newest notes across a project, latest call only. */
export function recentNotesLoader(list: (projectId: string, limit: number) => Promise<Note[]> = (id, limit) => api.notes.list(id, { limit })): (projectId: string, limit: number) => Promise<Latest<Note[]>> {
	return latestCall(list);
}
