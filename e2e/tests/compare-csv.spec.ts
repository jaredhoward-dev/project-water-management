// The run comparison's size of a table edit and its CSV download (issue #830):
// a monthly table changed in four or more months states its total and the
// month that moved most, and the comparison downloads as CSV, and as .xlsx
// with the same rows and numbers as number cells (issue #843).
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const EWR = [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000];

test('a zeroed EWR table states its size, and the comparison downloads as CSV', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Compare CSV');
	await updateSettings(page.request, project.id, { ewrPragmaticM3PerDay: EWR });
	const first = await createRun(page.request, project.id, 'Base');
	await updateSettings(page.request, project.id, { ewrPragmaticM3PerDay: new Array(12).fill(0) });
	const second = await createRun(page.request, project.id, 'No EWR');

	await page.goto(`/projects/${project.id}?tab=compare&a=${project.id}:${first}&b=${project.id}:${second}`);
	const changes = page.getByRole('region', { name: 'Inputs that differ' });
	await expect(changes.getByText('Pragmatic EWR: changed in 12 months: total 31 500 → 0 m³/day (−31 500), most in Jun 5 000 → 0 m³/day')).toBeVisible();

	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download the comparison (CSV)' }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe('Base vs No EWR - comparison.csv');
	const csv = await readFile((await file.path())!, 'utf8');
	expect(csv.split('\r\n')[0]).toBe('Run,Label,Project,Start,End,Engine');
	expect(csv).toContain('Pragmatic EWR: changed in 12 months');

	const xlsxDownload = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download the comparison (.xlsx)' }).click();
	const xlsxFile = await xlsxDownload;
	expect(xlsxFile.suggestedFilename()).toBe('Base vs No EWR - comparison.xlsx');
	const wb = XLSX.read(await readFile((await xlsxFile.path())!), { type: 'buffer' });
	expect(wb.SheetNames).toEqual(['Comparison']);
	const sheet = wb.Sheets['Comparison']!;
	const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true });
	expect(rows[0]).toEqual(['Run', 'Label', 'Project', 'Start', 'End', 'Engine']);
	expect(rows[1]!.slice(0, 2)).toEqual(['Baseline (A)', 'Base']);
	expect(rows.some((r) => typeof r[3] === 'string' && r[3].startsWith('Pragmatic EWR: changed in 12 months'))).toBe(true);
	// The outcomes' values are number cells, not text, in the same row as the CSV's.
	const csvLines = csv.split('\r\n');
	const outcomes = csvLines.indexOf('Outcome,Unit,Baseline (A),What-if (B),Change (B − A)');
	expect(outcomes).toBeGreaterThan(0);
	expect(rows[outcomes]).toEqual(['Outcome', 'Unit', 'Baseline (A)', 'What-if (B)', 'Change (B − A)']);
	const firstValue = rows.findIndex((r, i) => i > outcomes && typeof r[2] === 'number');
	expect(firstValue).toBeGreaterThan(outcomes);
	expect(sheet[XLSX.utils.encode_cell({ r: firstValue, c: 2 })]?.t).toBe('n');
});
