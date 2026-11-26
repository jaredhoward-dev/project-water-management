// View helpers for the Project page (ProjectTab.svelte, issue #17).
import { fmtDate, fmtDay, zonedIsoDate } from '#lib/format/number.js';

/** The zone a project dates its downloads by when the API sends none (issue #45). */
export const DEFAULT_TIME_ZONE = 'Africa/Johannesburg';

const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The project's calendar day (YYYY-MM-DD) at an ISO moment, in its time zone
 * (DEFAULT_TIME_ZONE when the API sends none), never UTC's or the device's:
 * the date a run's data-source credits were read on (issue #860), as the
 * backend dates a download's file name. A zone Intl doesn't know falls back
 * to the default zone.
 */
export function projectDay(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string {
	const at = new Date(iso);
	try {
		return zonedIsoDate(at, timeZone);
	} catch {
		return zonedIsoDate(at, DEFAULT_TIME_ZONE);
	}
}

/**
 * A moment as the project's calendar day for a reader, "27 Oct 2026": a run's
 * or a pack's date in a report (issue #860), never UTC's day (an ISO slice)
 * or the device's. A bare day (YYYY-MM-DD) is that day, never moved by a zone.
 */
export function fmtProjectDay(iso: string | null | undefined, timeZone?: string): string {
	if (!iso || Number.isNaN(new Date(iso).getTime())) return iso || '–';
	// A bare day has no time to move: UTC midnight is the day before west of Greenwich.
	if (BARE_DAY.test(iso)) return fmtDay(iso);
	return fmtDay(projectDay(iso, timeZone));
}

const stampFormats = new Map<string, Intl.DateTimeFormat>();

function zonedStampParts(at: Date, timeZone: string): { day: string; time: string } {
	let f = stampFormats.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
		stampFormats.set(timeZone, f);
	}
	const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
	return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * A moment with its time of day as the project's clock reads it, "27 Oct
 * 2026 00:30": a sign-off or a notes edit in an evidence report (issue #864),
 * beside run dates fmtProjectDay prints, so one page never dates in two
 * zones. DEFAULT_TIME_ZONE when none is given; a zone Intl doesn't know falls
 * back to it. A bare day (no time) is that day; a missing or unreadable date
 * is left as fmtProjectDay leaves it.
 */
export function fmtProjectStamp(iso: string | null | undefined, timeZone: string = DEFAULT_TIME_ZONE): string {
	if (!iso || Number.isNaN(new Date(iso).getTime())) return iso || '–';
	if (BARE_DAY.test(iso)) return fmtDay(iso);
	const at = new Date(iso);
	let parts: { day: string; time: string };
	try {
		parts = zonedStampParts(at, timeZone);
	} catch {
		parts = zonedStampParts(at, DEFAULT_TIME_ZONE);
	}
	return `${fmtDay(parts.day)} ${parts.time}`;
}

/**
 * A moment as a workspace list or status line says it on the project's clock:
 * "today 14:05", "yesterday 09:30" (the project's today, not the viewer's),
 * otherwise fmtProjectStamp's "3 Sep 2026 14:05" (issue #899: a run's date in
 * the Runs list and the run pickers reads as its report dates it). Not after
 * "on" in a sentence: use fmtProjectStamp there.
 */
export function fmtProjectWhen(iso: string | null | undefined, timeZone: string = DEFAULT_TIME_ZONE, now: Date = new Date()): string {
	const stamp = fmtProjectStamp(iso, timeZone);
	if (!iso || BARE_DAY.test(iso) || Number.isNaN(new Date(iso).getTime())) return stamp;
	const day = projectDay(iso, timeZone);
	const today = projectDay(now.toISOString(), timeZone);
	const yesterday = new Date(`${today}T12:00:00Z`);
	yesterday.setUTCDate(yesterday.getUTCDate() - 1);
	const word = day === today ? 'today' : day === yesterday.toISOString().slice(0, 10) ? 'yesterday' : null;
	return word ? `${word} ${stamp.slice(stamp.lastIndexOf(' ') + 1)}` : stamp;
}

/**
 * A run's name in the workspace: its label, else when it ran on the project's
 * clock, "27 Oct 2026 00:30", the moment the run report's "Run of …" names
 * (reportRunName; issue #899), never the viewer's.
 */
export function runDisplayName(run: { label?: string | null; createdAt: string }, timeZone: string = DEFAULT_TIME_ZONE): string {
	return run.label || fmtProjectStamp(run.createdAt, timeZone);
}

/**
 * The section header's context line: who owns the project, when it was
 * created and the time zone its downloads are dated by, e.g.
 * "Team “North WUA” · created 3 Sep 2026 · time zone Africa/Johannesburg".
 */
export function projectContext(p: { team: { name: string | null } | null; createdAt: string; timeZone?: string }): string {
	const owner = p.team ? (p.team.name ? `Team “${p.team.name}”` : 'A team project') : 'Personal project';
	const created = fmtDate(p.createdAt);
	return [owner, created === '–' ? null : `created ${created}`, `time zone ${p.timeZone ?? DEFAULT_TIME_ZONE}`]
		.filter(Boolean)
		.join(' · ');
}

/**
 * How many people Members and Farmers list before "Show all N" (issue #586
 * R4-F): with 30 members and 30 farmers, the one-column page put Recent notes
 * 5,000 px down at 1440 and 14,000 px down on a phone. As the Summary's
 * Supply by unit, a long list shows its first few and opens the rest in
 * place, rather than scrolling inside its card (ui-playbook § 2).
 */
export const PEOPLE_SHOWN = 8;

/**
 * The rows shown while a list is folded: the first `cap`, plus any later row
 * `keep` asks for (the reader's own, so Leave is never behind the fold). A
 * list of `cap + 1` shows whole: a button to reveal one row is worse than
 * the row. `hidden` is how many the fold keeps back (0: no button).
 */
export function foldRows<T>(rows: readonly T[], all: boolean, cap: number, keep: (row: T) => boolean = () => false): { shown: T[]; hidden: number } {
	if (all || rows.length <= cap + 1) return { shown: [...rows], hidden: 0 };
	const shown = rows.filter((r, i) => i < cap || keep(r));
	return { shown, hidden: rows.length - shown.length };
}

const naturalName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * People by name as a reader counts ("Farmer 2" before "Farmer 10"), within
 * the groups the server already sorts them into (Members: by role, owners
 * first), whose order stays. The server sorts names as text, which put
 * "Hydrologist 10" … "Hydrologist 19" before "Hydrologist 2".
 */
export function byName<T extends { displayName: string }>(rows: readonly T[], groupOf: (row: T) => string = () => ''): T[] {
	const rank = new Map<string, number>();
	for (const r of rows) if (!rank.has(groupOf(r))) rank.set(groupOf(r), rank.size);
	return [...rows].sort((a, b) => rank.get(groupOf(a))! - rank.get(groupOf(b))! || naturalName.compare(a.displayName, b.displayName));
}
