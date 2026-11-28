// The UPDATE the RLS table sweeps try on every project table
// (isolation.db.test.ts, teams/teams.security.db.test.ts,
// scenarios/applicant.security.db.test.ts, projects/below-editor.security.db.test.ts).
//
// A sweep that writes `SET project_id = project_id` only reaches RLS on a
// table where water_app may update project_id. Twenty project tables grant
// UPDATE column by column without it (note, model_run, project_member,
// evidence_pack, share_link, api_key, run_publication, …), so that statement
// failed on the grant (42501) before any policy ran, and the sweeps read the
// refusal as "nothing changed": their UPDATE policies were never tried. The
// probe sets a column the app role may update to itself instead, so the
// statement reaches the policy on every table it can update at all.
import { asOwner } from './helpers.js';

/** Per table, the columns water_app may UPDATE (from the column grants). */
export async function updatableColumns(): Promise<Map<string, string[]>> {
	const rows = await asOwner(
		`SELECT table_name AS t, column_name AS c FROM information_schema.column_privileges
		 WHERE grantee = 'water_app' AND privilege_type = 'UPDATE' AND table_schema = 'public'
		 ORDER BY 1, 2`
	);
	const out = new Map<string, string[]>();
	for (const r of rows as { t: string; c: string }[]) out.set(r.t, [...(out.get(r.t) ?? []), r.c]);
	return out;
}

/**
 * The column the probe sets to itself on `table`: `prefer` (the column the
 * sweep filters on) when the app role may update it, else the first one it
 * may update; null when it may update none (any UPDATE is refused on the grant).
 */
export function probeColumn(columns: Map<string, string[]>, table: string, prefer = 'project_id'): string | null {
	const cols = columns.get(table) ?? [];
	return cols.includes(prefer) ? prefer : (cols[0] ?? null);
}

/**
 * `UPDATE "<table>" x SET "<col>" = x."<col>" WHERE x.<where> = $1`, setting a
 * column the app role may update; null when it may update none.
 */
export function updateProbe(columns: Map<string, string[]>, table: string, where = 'project_id', returning = ''): string | null {
	const col = probeColumn(columns, table, where);
	if (!col) return null;
	return `UPDATE "${table}" x SET "${col}" = x."${col}" WHERE x.${where} = $1${returning ? ` RETURNING ${returning}` : ''}`;
}
