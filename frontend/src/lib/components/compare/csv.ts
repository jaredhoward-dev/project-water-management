// The run comparison as CSV (issue #830): the two runs, the headline
// outcomes with their raw numbers (the page rounds them), each hydrological
// unit's supply, and every input difference as the page words it. Written
// with the paste grid's csvCell, so a cell a spreadsheet would read as a
// formula is defused (docs/security.md). Pure: no I/O, no Svelte.
import type { RunCompareResponse } from '#lib/api/types.js';
import { toCsv } from '#lib/spreadsheet/paste/grid.js';
import { compareDamStorage, outcomeRows } from './summary';

export type Cell = string | number | null;

/** A fraction outcome (0–1) is written as a percentage, as its unit says ("% of days"). */
const scaled = (v: number | null, fraction: boolean): number | null => (v === null ? null : fraction ? v * 100 : v);

/**
 * The comparison of baseline A against what-if B as rows, one table after
 * another with an empty row between: the CSV and the .xlsx (./xlsx.ts, issue
 * #843) write these same cells.
 */
export function comparisonRows(d: RunCompareResponse): Cell[][] {
	const side = (name: string, s: RunCompareResponse['a']): Cell[] => [name, s.run.label || 'Untitled run', s.project.name, s.run.startDate, s.run.endDate, s.run.engineVersion];
	const table: Cell[][] = [['Run', 'Label', 'Project', 'Start', 'End', 'Engine'], side('Baseline (A)', d.a), side('What-if (B)', d.b)];

	table.push([], ['Outcome', 'Unit', 'Baseline (A)', 'What-if (B)', 'Change (B − A)']);
	for (const r of outcomeRows([d.comparison], [compareDamStorage(d)])) {
		const m = r.whatIfs[0]!;
		const f = r.spec.format === 'fraction';
		table.push([r.label, f ? `${r.unit} (per cent)` : r.unit, scaled(r.base, f), scaled(m.b, f), scaled(m.delta, f)]);
	}

	if (d.comparison.farms.length) {
		table.push([], ['Hydrological unit', 'Measure', 'Unit', 'Baseline (A)', 'What-if (B)', 'Change (B − A)']);
		for (const f of d.comparison.farms) {
			const name = f.nameA && f.nameA !== f.name ? `${f.name} (was ${f.nameA})` : f.name;
			const rows: [string, string, typeof f.demandM3Day, boolean][] = [
				['Demand', 'm³/day', f.demandM3Day, false],
				['Supplied', 'm³/day', f.suppliedM3Day, false],
				['Deficit', 'm³/day', f.deficitM3Day, false],
				['Supplied', '% of demand', f.fractionSupplied, true]
			];
			for (const [measure, unit, m, frac] of rows) table.push([name, measure, unit, scaled(m.a, frac), scaled(m.b, frac), scaled(m.delta, frac)]);
		}
	}

	table.push([], ['Area', 'Kind', 'Subject', 'Change']);
	for (const c of d.changes) table.push([c.area, c.kind, c.subject, c.text]);
	return table;
}

/** The comparison as CSV text. */
export const comparisonCsv = (d: RunCompareResponse): string => toCsv(comparisonRows(d));

/** The file name (`.csv`, or `.xlsx` for the workbook): both runs' labels, stripped to safe characters. */
export function comparisonCsvName(d: RunCompareResponse, ext: 'csv' | 'xlsx' = 'csv'): string {
	const safe = (s: string) => s.replace(/[^\w -]+/g, '').trim() || 'run';
	return `${safe(d.a.run.label || 'Untitled run')} vs ${safe(d.b.run.label || 'Untitled run')} - comparison.${ext}`;
}
