import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSeriesCsv } from './csv';
import { dwsFlowCheck, isDwsExport, parseDwsExport } from './dws';
import { parseSeriesFile } from './file';

// Synthetic (invented station and values), shared with the engine's and the DWS feed's
// tests (backend/src/feeds/sources/dws.test.ts), which read the same days from it.
const fixture = readFileSync(new URL('../../../../packages/engine/fixtures/dws-daily-export.txt', import.meta.url), 'utf8');
const EXPECTED = [0.412, 0.398, 1.897, null, null, null, 12.5, 0.371, null, 0.355, 0.349];

describe('a DWS export with bare CR line endings', () => {
	it('is recognised and read day for day like the LF file', () => {
		const cr = fixture.replace(/\r?\n/g, '\r');
		expect(isDwsExport(cr)).toBe(true);
		expect(parseSeriesFile(cr).values).toEqual(EXPECTED);
	});
});

describe('parseDwsExport on the shared fixture', () => {
	const r = parseDwsExport(fixture);

	it('reads the fixed-width YYYYMMDD table the feed reads, day for day', () => {
		expect(r.startDate).toBe('2021-01-01');
		expect(r.endDate).toBe('2021-01-11');
		expect(r.values).toEqual(EXPECTED);
		expect([r.rowCount, r.missingCount, r.dateOrder, r.dateOrderAssumed]).toEqual([7, 4, 'iso', false]);
	});

	it('never imports a missing-data code or a -999: they are gaps, counted by why', () => {
		expect(r.dws).toEqual({
			rows: 10,
			quality: { '1': 6, '2': 1, '60': 1, '170': 1, '255': 1 },
			gaps: { code: 2, blank: 0, negative: 1 },
			gapCodes: { '170': 1, '255': 1 },
			column: 'Daily avg flow rate in cubic metres/sec 99999.999',
			unit: 'm³/s',
			quantity: 'flow'
		});
		expect(r.values).not.toContain(-999);
		// 20210105 carries 0.000 under code 255: a gap, not a dry day.
		expect(r.values[4]).toBeNull();
	});

	it('reads the same table saved as the web page (its <pre>)', () => {
		const page = `<p><pre>${fixture.replace(/&/g, '&amp;')}</pre></p>\n<!DOCTYPE html><html><head><title>X0H000100.00</title></head><body></body></html>`;
		expect(isDwsExport(page)).toBe(true);
		expect(parseSeriesFile(page).values).toEqual(EXPECTED);
	});
});

describe('parseDwsExport on other exports', () => {
	it('gives the unit the format block states for its values (m³/s), and none it can’t name', () => {
		const spec = (what: string) => `POS. 10-18 = ${what}\nDATE     D AVG F/R  QUAL\n20210101     1.500     1\n`;
		expect(parseDwsExport(spec('Daily avg flow rate in cubic metres/sec')).dws!.unit).toBe('m³/s');
		expect(parseDwsExport(spec('Daily average flow in m3/s')).dws!.unit).toBe('m³/s');
		expect(parseDwsExport(spec('Daily rainfall in mm')).dws!.unit).toBeUndefined();
		expect(parseDwsExport('20210101  1.5  1\n').dws!.unit).toBeUndefined();
	});

	it('reads headerless whitespace rows (date, value, quality), a tab-separated one too', () => {
		const r = parseSeriesFile('20210101  1.5  1\n20210102  -999  1\n20210103\t2.25\t60\n');
		expect(r.values).toEqual([1.5, null, 2.25]);
		expect(r.dws!.gaps).toEqual({ code: 0, blank: 0, negative: 1 });
	});

	it('reads NA as a blank, and counts a blank-value gap row', () => {
		const r = parseDwsExport('DATE     D AVG F/R  QUAL\n20210101        NA     1\n20210102               172\n20210103     0.500     1\n');
		expect(r.values).toEqual([null, null, 0.5]);
		expect(r.dws!.gaps).toEqual({ code: 1, blank: 1, negative: 0 });
		expect(r.dws!.gapCodes).toEqual({ '172': 1 });
	});

	it('refuses what it can’t read, with the real reason', () => {
		const table = (rows: string) => `DATE     D AVG F/R  QUAL\n${rows}\n`;
		expect(() => parseDwsExport(table('20210230     1.000     1'))).toThrow('Line 2: "20210230" is not a date (a DWS date is YYYYMMDD)');
		expect(() => parseDwsExport(table('20210101       abc     1'))).toThrow('Line 2: "abc" on 2021-01-01 is not a number');
		expect(() => parseDwsExport(table('20210101     1.000     1\n20210101     2.000     1'))).toThrow('Line 3: duplicate date 2021-01-01');
		expect(() => parseDwsExport('DATE       TIME   COR_LEVEL QUAL\n20210101 0800 1.2 1\n')).toThrow(/has a TIME column/);
		expect(() => parseDwsExport('DATE D_AVG_FR QUAL\nNo data for this period\n')).toThrow(/No data for this period/);
	});
});

describe('isDwsExport / parseSeriesFile', () => {
	it('sends a DWS table to the DWS reader and anything else to the CSV reader', () => {
		expect(isDwsExport(fixture)).toBe(true);
		expect(isDwsExport('20210101 1.5 1\n')).toBe(true);
		// Commas or semicolons make it a CSV, compact dates and all.
		expect(isDwsExport('20210101,1.5\n')).toBe(false);
		expect(isDwsExport('20210101;1,5\n')).toBe(false);
		expect(isDwsExport('date\tvalue\n2021-01-01\t1.5\n')).toBe(false);
		expect(isDwsExport('Date Value\n2021-01-01 1.5\n')).toBe(false);
	});

	it('positive control: an ordinary CSV reads exactly as parseSeriesCsv reads it, with no DWS summary', () => {
		const csv = 'date,value\n2021-10-01,1.5\n2021-10-03,\n2021-10-04,2\n';
		expect(parseSeriesFile(csv)).toEqual(parseSeriesCsv(csv));
		expect(parseSeriesFile(csv).dws).toBeUndefined();
		// A whole 08:00 day of hourly readings (09:00 on the 5th to 08:00 on the 6th).
		const hourly = ['time,rain', ...Array.from({ length: 24 }, (_, h) => `${new Date(Date.UTC(2020, 0, 5, 9 + h)).toISOString().slice(0, 16).replace('T', ' ')},1`)].join('\n');
		expect(parseSeriesFile(hourly, { dayBoundary: '08:00', aggregate: 'sum' })).toEqual(parseSeriesCsv(hourly, { dayBoundary: '08:00', aggregate: 'sum' }));
	});
});

// Issue #909. Synthetic tables; the format-block wordings are HyData's own where DWS's are known
// (a primary export's "Corrected level in m", a monthly export's "Monthly volumes in million cubic
// metres"), and plausible daily variants where they aren't.
describe('a DWS export of a water level or a volume (issue #909)', () => {
	const spec = (what: string) => `POS.  1-8   = Date CCYYMMDD\nPOS. 10-18  = ${what}\nPOS. 20-24  = Quality code\nX0R000\nDATE     D AVG F/R  QUAL\n20210101   102.345     1\n`;

	it('is refused, naming the level and its unit from the format block', () => {
		expect(() => parseDwsExport(spec('Corrected level in m'))).toThrow(
			'this DWS export holds a water level (m), not a flow, rain or evaporation: its format block says "Corrected level in m". Export the station\'s daily flow (m³/s) instead'
		);
		expect(() => parseDwsExport(spec('Daily avg water level in metres 999.999'))).toThrow(/holds a water level \(m\)/);
		expect(() => parseDwsExport(spec('Surface Water Level'))).toThrow(/holds a water level, not a flow/);
	});

	it('is refused, naming the volume and its unit', () => {
		expect(() => parseDwsExport(spec('Daily volumes in million cubic metres'))).toThrow(/holds a volume \(million m³\)/);
		expect(() => parseDwsExport(spec('Storage in Mm³'))).toThrow(/holds a volume \(million m³\)/);
		expect(() => parseDwsExport(spec('Daily volume in cubic metres'))).toThrow(/holds a volume \(m³\)/);
	});

	it('still reads a flow, also one that says cubic metres per second', () => {
		expect(parseDwsExport(spec('Daily avg flow rate in cubic metres per second')).dws).toMatchObject({ unit: 'm³/s', quantity: 'flow' });
	});
});

describe('dwsFlowCheck (issue #909)', () => {
	const spec = (what: string) => `POS. 10-18 = ${what}\nDATE     D AVG F/R  QUAL\n20210101     1.500     1\n`;

	it('asks before a flow kind takes an export whose format block states no flow unit', () => {
		const d = parseDwsExport(spec('Daily average value 99999.999')).dws;
		expect(d!.quantity).toBe('unstated');
		expect(dwsFlowCheck(d, 'flow_observed_m3s')).toBe(
			'The file\'s format block says its values are "Daily average value 99999.999", with no flow unit (m³/s), so they may be a dam\'s level or volume rather than a flow.'
		);
		expect(dwsFlowCheck(d, 'flow_logger_m3s')).not.toBeNull();
	});

	it('asks nothing for a stated flow, a depth kind, or headerless rows (no format block)', () => {
		expect(dwsFlowCheck(parseDwsExport(spec('Daily avg flow rate in cubic metres/sec')).dws, 'flow_observed_m3s')).toBeNull();
		expect(dwsFlowCheck(parseDwsExport(spec('Daily rainfall in mm')).dws, 'rain_catchment_mm')).toBeNull();
		expect(dwsFlowCheck(parseDwsExport(spec('Daily pan evaporation in millimetres 9999.9')).dws, 'evap_apan_mm')).toBeNull();
		expect(dwsFlowCheck(parseDwsExport('20210101  1.5  1\n').dws, 'flow_observed_m3s')).toBeNull();
		expect(dwsFlowCheck(undefined, 'flow_observed_m3s')).toBeNull();
	});
});
