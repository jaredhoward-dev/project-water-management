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
	return { ...denseDays(byDay), dateOrder: 'iso', dateOrderAssumed: false, dws: info };
}
