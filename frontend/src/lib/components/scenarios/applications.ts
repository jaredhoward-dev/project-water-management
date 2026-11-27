// The assessors' Applications list (ApplicationsTab.svelte, WP-3.3): its sort,
// the status filter (`status=` in the URL), the counts and the header's line.
// Pure, so it is unit-tested without a component.
import { OUTCOME_LABEL, type Scenario, type ScenarioOutcome } from '#lib/api/types.js';

export type ApplicationSort = 'date' | 'status';

/** The sort in the URL: `?sort=status`; none (or anything else) is newest first, so a reload and Back keep it. */
export function parseSort(v: string | null): ApplicationSort {
	return v === 'status' ? 'status' : 'date';
}

/** Awaiting a decision first: it is the assessor's queue. Then withdrawn, then decided. */
const STATUS_ORDER: Record<Scenario['status'], number> = { submitted: 0, withdrawn: 1, decided: 2, draft: 3 };

const when = (a: Scenario) => a.submittedAt ?? a.updatedAt;

/**
 * `date`: newest submission first. `status`: awaiting a decision first, then
 * withdrawn, then decided, the oldest submission first within each (the one
 * waiting longest on top). Ties by name, then id, so the order is stable.
 */
export function sortApplications(items: readonly Scenario[], sort: ApplicationSort): Scenario[] {
	const byName = (a: Scenario, b: Scenario) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
	return [...items].sort((a, b) => {
		if (sort === 'status') return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || when(a).localeCompare(when(b)) || byName(a, b);
		return when(b).localeCompare(when(a)) || byName(a, b);
	});
}

/** The status filter: `?status=awaiting|decided|withdrawn`, none (or anything else) for all. */
export const APPLICATION_FILTERS = ['all', 'awaiting', 'decided', 'withdrawn'] as const;
export type ApplicationFilter = (typeof APPLICATION_FILTERS)[number];
export const FILTER_LABEL: Record<ApplicationFilter, string> = { all: 'All', awaiting: 'Awaiting a decision', decided: 'Decided', withdrawn: 'Withdrawn' };
const FILTER_STATUS: Record<Exclude<ApplicationFilter, 'all'>, Scenario['status']> = { awaiting: 'submitted', decided: 'decided', withdrawn: 'withdrawn' };

export function parseFilter(v: string | null): ApplicationFilter {
	return v === 'awaiting' || v === 'decided' || v === 'withdrawn' ? v : 'all';
}

export function filterApplications(items: readonly Scenario[], f: ApplicationFilter): Scenario[] {
	return f === 'all' ? [...items] : items.filter((a) => a.status === FILTER_STATUS[f]);
}

export function applicationCounts(items: readonly Scenario[]): Record<ApplicationFilter, number> {
	const n = (s: Scenario['status']) => items.filter((a) => a.status === s).length;
	return { all: items.length, awaiting: n('submitted'), decided: n('decided'), withdrawn: n('withdrawn') };
}

const DAY_MS = 86_400_000;

/** Whole days since `iso` at `now` (0 on the day itself). */
export function daysSince(iso: string, now: number): number {
	return Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));
}

export const daysText = (d: number) => (d === 0 ? 'less than a day' : `${d} day${d === 1 ? '' : 's'}`);

/** The application awaiting a decision that was submitted first (the next to decide), or null. */
export function longestWaiting(items: readonly Scenario[]): Scenario | null {
	return sortApplications(items, 'status').find((a) => a.status === 'submitted') ?? null;
}

/**
 * The section header's line: "30 applications · 17 awaiting a decision, the
 * longest for 30 days", "4 applications · none awaiting a decision", or "No
 * applications submitted yet".
 */
export function applicationsContext(items: readonly Scenario[], now: number): string {
	if (!items.length) return 'No applications submitted yet';
	const c = applicationCounts(items);
	const total = `${c.all} application${c.all === 1 ? '' : 's'}`;
	if (!c.awaiting) return `${total} · none awaiting a decision`;
	const first = longestWaiting(items);
	const waited = first?.submittedAt ? `, the longest for ${daysText(daysSince(first.submittedAt, now))}` : '';
	return `${total} · ${c.awaiting} awaiting a decision${waited}`;
}

/** The status pill: its words and its tone (the band colours; the words carry the meaning). */
export function statusPill(a: Pick<Scenario, 'status' | 'outcome'>): { text: string; tone: 'awaiting' | 'good' | 'mixed' | 'bad' | 'neutral' } {
	if (a.status === 'submitted') return { text: 'Awaiting a decision', tone: 'awaiting' };
	if (a.status === 'withdrawn') return { text: 'Withdrawn', tone: 'neutral' };
	if (a.status === 'draft') return { text: 'Draft', tone: 'neutral' };
	// The authority's words (163_licensing_authority): a licence issued always carries conditions (NWA s28(1)(d)).
	const TONE: Record<ScenarioOutcome, 'good' | 'mixed' | 'bad'> = { licence_issued: 'good', licence_refused: 'bad', application_rejected: 'bad', not_considered: 'mixed' };
	return a.outcome ? { text: OUTCOME_LABEL[a.outcome], tone: TONE[a.outcome] } : { text: 'Decided', tone: 'neutral' };
}

/**
 * The Application panel's error for a move the server refused as a conflict,
 * once it has read the application again: one sentence (issue #934), with the
 * server's own words, which start lower-case and end without a stop, in
 * brackets rather than glued on with ". ".
 */
export function applicationConflictText(serverText: string): string {
	const said = serverText.trim().replace(/[.\s]+$/, '');
	return `The application changed since this page read it, so the move was refused${said ? ` (${said})` : ''}; someone else may have withdrawn, reopened or decided it, and it now shows where it stands.`;
}

/**
 * After the server refused a move on an application: a 409 is a conflict
 * (another user withdrew, reopened, submitted or decided it since the panel
 * read it), so read it again and hand it back, for the panel to show its
 * current status and moves rather than the stale ones. Any other refusal, or
 * a read that fails, gives null: the panel stays as it was, with the error.
 */
export async function rereadAfterConflict<T>(e: unknown, reread: () => Promise<T>): Promise<T | null> {
	const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
	if (status !== 409) return null;
	try {
		return await reread();
	} catch {
		return null;
	}
}

/**
 * The heading to land on when the Applications tab switches between its list and Assess together
 * (`view=assess`): the new view's heading, which takes the focus and so the scroll (ui-playbook.md §
 * a link that moves to another part of the page). null when the view didn't change (the first render,
 * a sort or filter step), which keeps the place.
 */
export function applicationsViewHeading(prev: boolean | null, assess: boolean): 'assess-h' | 'applications-h' | null {
	if (prev === null || prev === assess) return null;
	return assess ? 'assess-h' : 'applications-h';
}
