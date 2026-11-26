// A DWS hydrology export in the manual series import (issue #45): the
// fixed-width daily table the DWS Hydrological Services site prints
// (HyData.aspx, saved as text or as the page), or plain whitespace-separated
// "YYYYMMDD value [quality]" rows.
//
// Rows are read by the same code as the automatic DWS feed
// (@water-management/engine/dws, parseDwsRow), so a missing-data quality code
// (170, 255 …), a blank value or a negative placeholder (-999) is a gap here
// exactly as it is there: never a value that gets imported and scored. What
// was dropped, and why, is returned for the upload summary.
import { toEpochDay } from '@water-management/engine';
import { DWS_HEADER, DWS_ROW, dwsColumns, dwsTableText, parseDwsRow, type DwsColumns, type DwsGap } from '@water-management/engine/dws';
import { CsvError, denseDays, type ParsedSeries } from './csv';

export interface DwsImport {
	/** Dated rows in the file. */
	rows: number;
	/** Rows by quality code, as the file gave them. */
	quality: Record<string, number>;
	/** Rows read as gaps, by why: a missing-data code, a blank or NA value, a negative placeholder. */
	gaps: Record<Exclude<DwsGap, 'text'>, number>;
	/** The missing-data quality codes met, with their rows. */
	gapCodes: Record<string, number>;
	/** The value column as the file's format block describes it ("Daily avg flow rate in cubic metres/sec"). */
	column?: string;
	/** The unit that block states for the values, when it names m³/s (DWS flow); absent otherwise. The form sets its Unit to it. */
	unit?: 'm³/s';
	/**
	 * What that block says the values are, when there is one: a flow (it states m³/s), or `unstated`
	 * (no flow unit), which the form imports as a flow only once the person confirms (dwsFlowCheck).
	 * A level or a volume never gets here: parseDwsExport refuses it.
	 */
	quantity?: 'flow' | 'unstated';
	/**
	 * The DWS station code the file names (A2H012, X0R000: a letter, a digit, the site type, three digits), when it
	 * names one outside its data rows: a saved page's URL (Station=X0R000100.00) or a heading (issue #925).
	 */
	station?: string;
}

const NO_READING = /^(na|nan|null|-)$/i;
const VALUE_SPEC = /^\s*POS\.\s*10\s*-\s*18\s*=\s*/i;
/** A stated unit of m³/s (the automatic feed's own check, backend feeds/sources/dws.ts M3S). */
const M3S = /cubic met(re|er)s?\s*(\/|per)\s*s(ec(ond)?)?\b|\bm(3|³)\s*\/\s*s\b|\bcumecs\b/i;
// A water level or a volume, as HyData's format blocks word them: a primary (point) export's
// "POS. 27-35 = Corrected level in m", a monthly export's "Monthly volumes in million cubic metres"
// (both as DWS prints them; the daily wording for a reservoir isn't known here, so these are
// matched loosely). Neither is a rain, a flow or an evaporation, the only kinds a series can be.
const LEVEL = /\b(water\s+|surface\s+|dam\s+|gauge\s+)?(level|stage|height)\b/i;
const VOLUME = /\b(volumes?|storage|stored|capacity)\b|million\s+cubic\s+met(re|er)s?|\b(m|h)m(3|³)(?!\w)|\bcubic\s+met(re|er)s?\b(?!\s*(\/|per))/i;

// A DWS station code: drainage region letter, a digit, the site type (H river gauge, R reservoir, E weather
// station …) and three digits, optionally with HyData's "100.00" suffix (Station=A2H012100.00).
const STATION_CODE = /(?<![A-Za-z0-9])([A-Z]\d[A-Z]\d{3})(?=100\.00|[^A-Za-z0-9]|$)/;

/** The station code a file's text names outside its data rows: one after "Station", else the first one. */
function stationIn(text: string): string | undefined {
	const named = /station\W{0,3}([A-Z]\d[A-Z]\d{3})(?=100\.00|[^A-Za-z0-9]|$)/i.exec(text);
	if (named) return named[1]!.toUpperCase();
	return STATION_CODE.exec(text)?.[1];
}

/** The station code in a file name ("X0R000.txt", "HyData X0R000 2020.html"), else undefined. */
export function dwsStationInName(fileName: string | undefined): string | undefined {
	const base = (fileName ?? '').split(/[\\/]/).pop() ?? '';
	return STATION_CODE.exec(base.toUpperCase())?.[1];
}

/** Whether a station code is a reservoir's (R in the third place, HyData's SiteType=RES; backend feeds/sources/dws.ts). */
export const isReservoirStation = (code: string | undefined): boolean => !!code && code[2] === 'R';

/** Which unit a level or volume column is in, for the refusal ("in m", "in million m³"); undefined when the block doesn't say. */
function levelOrVolume(column: string): { what: 'level' | 'volume'; unit?: string } | null {
	if (M3S.test(column)) return null;
	if (VOLUME.test(column)) {
		const unit = /million\s+cubic|\b(m|h)m(3|³)(?!\w)/i.test(column) ? 'million m³' : /cubic\s+met|\bm(3|³)(?!\w)/i.test(column) ? 'm³' : undefined;
		return { what: 'volume', unit };
	}
	if (LEVEL.test(column)) return { what: 'level', unit: /\bin\s+m(et(re|er)s?)?\b|\(m\)/i.test(column) ? 'm' : undefined };
	return null;
}

/**
 * Whether an upload of this DWS export as `kind` needs the person to confirm it first: a flow kind
 * from an export whose format block states no flow unit (it could be a level or a volume worded
 * in a way not recognised here, issue #909). The message says why; null when nothing to confirm.
 */
export function dwsFlowCheck(dws: DwsImport | undefined, kind: string): string | null {
	if (!dws || dws.quantity !== 'unstated' || !kind.endsWith('_m3s')) return null;
	return `The file's format block says its values are "${dws.column}", with no flow unit (m³/s), so they may be a dam's level or volume rather than a flow.`;
}

/**
 * Something about a DWS export the form says before an upload: `confirm` is the checkbox's words when ticking it
 * lets the upload go ahead, null when the upload is refused for this kind (another kind is the answer).
 */
export interface DwsCheck {
	id: 'unstated' | 'reservoir' | 'flow-not-depth' | 'flow-station';
	title: string;
	message: string;
	confirm: string | null;
}

/**
 * Every check on uploading this DWS export as `kind` (issues #909, #925): an unstated unit taken as a flow
 * (dwsFlowCheck), a reservoir station's table taken as a flow (its daily "flow" is the spillway discharge,
 * not the river's), a stated flow (m³/s) taken as rain or evaporation, which is refused, and a
 * river gauge's or reservoir's table with no stated unit taken as rain or evaporation, which is confirmed. `fileName`
 * gives the station code when the text names none. `unit` is the form's unit, for the checkbox's words.
 */
export function dwsChecks(dws: DwsImport | undefined, kind: string, fileName?: string, unit = 'm³/s'): DwsCheck[] {
	if (!dws) return [];
	const checks: DwsCheck[] = [];
	const flowKind = kind.endsWith('_m3s');
	if (!flowKind && dws.quantity === 'flow') {
		checks.push({
			id: 'flow-not-depth',
			title: 'A flow, not a depth',
			message: `The file's format block says its values are "${dws.column}", a flow in m³/s, so they can't be imported as rain or evaporation (a depth in mm). Choose a flow kind, or export the station's rain or evaporation instead.`,
			confirm: null
		});
	}
	const station = dws.station ?? dwsStationInName(fileName);
	// A river gauge's (H) or a reservoir's (R) table with no stated unit, taken as rain or evaporation: the station
	// measures a flow or a spill, so the person says it is a depth first (the stated-m³/s case is refused above).
	if (!flowKind && dws.quantity !== 'flow' && station && (station[2] === 'H' || station[2] === 'R')) {
		const what = station[2] === 'R' ? 'a reservoir station, whose daily table is the spillway discharge' : 'a river gauge, whose daily table is a flow';
		checks.push({
			id: 'flow-station',
			title: 'A flow station',
			message: `${station} is ${what} (m³/s), not rain or evaporation, though the file states no unit.`,
			confirm: `These values are daily depths in ${unit}, not a flow or discharge`
		});
	}
	if (flowKind && isReservoirStation(station)) {
		checks.push({
			id: 'reservoir',
			title: 'A reservoir station',
			message: `${station} is a reservoir station (R in its code): DWS's daily table for a dam reports the spillway discharge worked out from the dam's level, not the river's flow, so it scores a run only where the spill is the flow you mean.`,
			confirm: `These values are the spillway discharge I mean to import as ${kind === 'flow_observed_m3s' ? 'observed flow' : 'this flow'}`
		});
	}
	const unstated = dwsFlowCheck(dws, kind);
	if (unstated) checks.push({ id: 'unstated', title: 'Not said to be a flow', message: unstated, confirm: `These values are daily flows in ${unit}` });
	return checks;
}

/**
 * Whether a file is a DWS-style table rather than a CSV: it has a DATE … QUAL
 * header before any dated row, or its first line that starts with a digit is a YYYYMMDD date followed by whitespace, with no comma
 * or semicolon in it (20200105,5 or 20200105;1,5 is a CSV, read by csv.ts).
 */
export function isDwsExport(text: string): boolean {
	const body = dwsTableText(text) ?? text;
	for (const raw of body.split(/\r\n?|\n/)) {
		const l = raw.trim();
		if (DWS_HEADER.test(l) && /\bQUAL\b/i.test(l)) return true;
		if (/^\d/.test(l)) return DWS_ROW.test(l) && !/[,;]/.test(l);
	}
	return false;
}

/** Read a DWS export (isDwsExport) into daily values. Every date is year-first, so no date order is assumed. */
export function parseDwsExport(text: string): ParsedSeries {
	const clean = text.replace(/^﻿/, '');
	const table = dwsTableText(clean);
	// Line numbers are the file's only when the table is the file (not a saved page's <pre>).
	const plain = table === null || table === clean;
	const lines = (table ?? clean).split(/\r\n?|\n/).map((l) => l.trimEnd());
	const lineNo = (i: number) => (plain ? i + 1 : undefined);
	const firstRow = lines.findIndex((l) => DWS_ROW.test(l.trim()));
	const h = lines.findIndex((l) => DWS_HEADER.test(l));
	let cols: DwsColumns | null = null;
	let column: string | undefined;
	if (h !== -1 && (firstRow === -1 || h < firstRow)) {
		if (/\bTIME\b/i.test(lines[h]!)) {
			throw new CsvError('this DWS export has a TIME column, so it holds readings through the day; export the daily data instead', lineNo(h));
		}
		cols = dwsColumns(lines[h]!);
		column = lines
			.slice(0, h)
			.find((l) => VALUE_SPEC.test(l))
			?.replace(VALUE_SPEC, '')
			.trim();
	}
	const byDay = new Map<number, number | null>();
	const info: DwsImport = { rows: 0, quality: {}, gaps: { code: 0, blank: 0, negative: 0 }, gapCodes: {} };
	for (let i = 0; i < lines.length; i++) {
		if (!DWS_ROW.test(lines[i]!.trim())) continue;
		const row = parseDwsRow(lines[i]!, cols);
		if (row.iso === null) throw new CsvError(`"${row.date}" is not a date (a DWS date is YYYYMMDD)`, lineNo(i));
		let gap = row.gap;
		if (gap === 'text') {
			if (!NO_READING.test(row.rawValue ?? '')) throw new CsvError(`"${row.rawValue}" on ${row.iso} is not a number`, lineNo(i));
			gap = 'blank';
		}
		const day = toEpochDay(row.iso);
		if (byDay.has(day)) throw new CsvError(`duplicate date ${row.iso}`, lineNo(i));
		byDay.set(day, row.value);
		info.rows++;
		if (row.quality) info.quality[row.quality] = (info.quality[row.quality] ?? 0) + 1;
		if (gap !== null) info.gaps[gap]++;
		if (gap === 'code') info.gapCodes[row.quality!] = (info.gapCodes[row.quality!] ?? 0) + 1;
	}
	if (byDay.size === 0 && /no data for this period/i.test(clean)) throw new CsvError('the DWS export says "No data for this period": it holds no days');
	if (column) {
		info.column = column;
		const lv = levelOrVolume(column);
		if (lv) {
			throw new CsvError(
				`this DWS export holds a ${lv.what === 'level' ? 'water level' : 'volume'}${lv.unit ? ` (${lv.unit})` : ''}, not a flow, rain or evaporation: its format block says "${column}". Export the station's daily flow (m³/s) instead`
			);
		}
		if (M3S.test(column)) {
			info.unit = 'm³/s';
			info.quantity = 'flow';
		} else info.quantity = 'unstated';
	}
	const station = stationIn(lines.filter((l) => !DWS_ROW.test(l.trim())).join('\n') + (plain ? '' : `\n${clean}`));
	if (station) info.station = station;
	return { ...denseDays(byDay), dateOrder: 'iso', dateOrderAssumed: false, dws: info };
}
