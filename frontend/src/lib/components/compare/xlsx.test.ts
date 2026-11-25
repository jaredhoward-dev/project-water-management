import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import { metricDelta, type FarmDelta, type RunComparison } from '@water-management/engine';
import type { RunCompareResponse } from '#lib/api/types.js';
import { comparisonCsv, comparisonCsvName, comparisonRows } from './csv';
import { comparisonCell, comparisonXlsx, COMPARISON_SHEET } from './xlsx';

const farm: FarmDelta = {
	name: 'Rooikloof',
	nameA: 'Old Rooikloof',
	nodeIdA: 'f1',
	nodeIdB: 'f1',
	demandM3Day: metricDelta(1000, 1000),
	suppliedM3Day: metricDelta(900, 450.5),
	deficitM3Day: metricDelta(100, 549.5),
	fractionSupplied: metricDelta(0.9, 0.4505),
	ewrShortfallM3Day: metricDelta(0, 0),
	daysEwrNotMet: metricDelta(0, 0)
};

/** A synthetic comparison with the fields the download reads (as csv.test.ts). */
function response(changes?: RunCompareResponse['changes']): RunCompareResponse {
	const side = (label: string, engine: string) => ({
		project: { id: 'p', name: 'Sandspruit' },
		run: { label, startDate: '2000-10-01', endDate: '2010-09-30', engineVersion: engine, summary: { farms: [] }, inputs: { model: { nodes: [] } } }
	});
	return {
		a: side('Base', '1.119.0'),
		b: side('Raised dam', '1.120.0'),
		comparison: {
			samePeriod: true,
			engineVersionChanged: true,
			farms: [farm],
			totals: { fractionSupplied: metricDelta(0.9, 0.4505), deficitM3Day: metricDelta(100, 549.5), farmsBelowTarget: metricDelta(1, 1) },
			catchment: { ewrFractionDaysNotMet: metricDelta(0.1, 0.25) }
		} as unknown as RunComparison,
		changes: changes ?? [{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 400 000 m³ → 400 000.4 m³' }],
		catchmentSeries: []
	} as unknown as RunCompareResponse;
}

/** The workbook read back with SheetJS (tests only; the app writes its own OOXML). */
async function readBack(d: RunCompareResponse) {
	const wb = XLSX.read(await comparisonXlsx(d), { type: 'array' });
	expect(wb.SheetNames).toEqual([COMPARISON_SHEET]);
	const sheet = wb.Sheets[COMPARISON_SHEET]!;
	const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true, defval: null });
	return { sheet, rows };
}

const findRow = (rows: unknown[][], ...head: unknown[]) => rows.find((r) => head.every((h, i) => r[i] === h));

describe('comparisonXlsx', () => {
	it('holds the same rows as the CSV, numbers as number cells', async () => {
		const d = response();
		const { sheet, rows } = await readBack(d);
		// Cell for cell, the CSV's rows: empty cells and trailing empties compared alike.
		const trim = (r: readonly unknown[]) => {
			const out = r.map((v) => (v === '' || v === undefined ? null : typeof v === 'number' ? Number(v.toPrecision(12)) : v));
			while (out.length && out.at(-1) === null) out.pop();
			return out;
		};
		expect(rows.map(trim)).toEqual(comparisonRows(d).map(trim));

		expect(rows[0]).toEqual(['Run', 'Label', 'Project', 'Start', 'End', 'Engine']);
		expect(rows[1]!.slice(0, 2)).toEqual(['Baseline (A)', 'Base']);
		// A fraction is a per cent, unrounded and without float noise, stored as a number.
		const supplied = findRow(rows, 'Irrigation supplied');
		expect(supplied).toEqual(['Irrigation supplied', '% of demand (per cent)', 90, 45.05, -44.95, null]);
		const unit = findRow(rows, 'Rooikloof (was Old Rooikloof)', 'Deficit');
		expect(unit).toEqual(['Rooikloof (was Old Rooikloof)', 'Deficit', 'm³/day', 100, 549.5, 449.5]);
		const r = rows.indexOf(supplied!) + 1;
		expect(sheet[`C${r}`]).toMatchObject({ t: 'n', v: 90 });
		expect(sheet[`E${r}`]).toMatchObject({ t: 'n', v: -44.95 });
		expect(findRow(rows, 'network', 'changed', 'Rooikloof')?.[3]).toBe('Rooikloof: dam capacity 400 000 m³ → 400 000.4 m³');
		// The CSV still writes the same table.
		expect(comparisonCsv(d)).toContain('Irrigation supplied,% of demand (per cent),90,45.05,-44.95');
	});

	it('defuses text a spreadsheet would read as a formula, as the CSV does', async () => {
		const { rows } = await readBack(response([{ area: 'settings', kind: 'changed', subject: '=HYPERLINK("x")', text: '+1 m³/day, -2' }]));
		const row = findRow(rows, 'settings', 'changed');
		expect(row?.slice(2, 4)).toEqual([`'=HYPERLINK("x")`, `'+1 m³/day, -2`]);
	});

	it('leaves an unknown or non-finite number empty rather than writing text', () => {
		expect(comparisonCell(null)).toBeUndefined();
		expect(comparisonCell(Number.NaN)).toBeUndefined();
		expect(comparisonCell(0.1 + 0.2)).toEqual({ t: 'n', v: 0.3 });
		expect(comparisonCell('@x')).toEqual({ t: 's', v: "'@x" });
	});

	it('names the file after both runs, with .xlsx', () => {
		expect(comparisonCsvName(response(), 'xlsx')).toBe('Base vs Raised dam - comparison.xlsx');
	});
});
