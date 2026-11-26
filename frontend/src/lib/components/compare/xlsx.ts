// The run comparison as .xlsx (issue #843): the CSV's rows (./csv.ts
// comparisonRows) on one sheet, written with the app's own OOXML writer (no
// SheetJS in app code, docs/STACK.md). Numbers are number cells, so a
// consultant can paste them into an application and sum them; text is
// defused as in the CSV (docs/security.md), and the writer stores it as a
// string cell Excel never evaluates. CompareView loads this module with a
// dynamic import, so the writer stays out of the compare page's chunk.
import type { RunCompareResponse } from '#lib/api/types.js';
import { defuse } from '#lib/spreadsheet/export/names.js';
import { XlsxWorkbook, type XlsxCell } from '#lib/spreadsheet/export/writer.js';
import { comparisonRows, type Cell } from './csv';

export const COMPARISON_SHEET = 'Comparison';

/** Column widths in characters: the first column holds outcome and unit names, the last the input change. */
const WIDTHS = [32, 22, 22, 16, 16, 16];

/** One cell: a finite number as a number (without float noise, as the CSV writes it), text defused, null left empty. */
export function comparisonCell(v: Cell): XlsxCell | undefined {
	if (typeof v === 'number') return Number.isFinite(v) ? { t: 'n', v: Number(v.toPrecision(12)) } : undefined;
	if (v === null || v === '') return undefined;
	return { t: 's', v: defuse(v) };
}

/** The comparison as .xlsx bytes: one sheet, the same rows and columns as the CSV. */
export async function comparisonXlsx(d: RunCompareResponse): Promise<Uint8Array<ArrayBuffer>> {
	const rows = comparisonRows(d);
	const lastCol = Math.max(0, ...rows.map((r) => r.length - 1));
	const book = new XlsxWorkbook();
	book.addRows(COMPARISON_SHEET, rows.map((r) => r.map(comparisonCell)), lastCol, WIDTHS);
	return book.bytes();
}
