// Load a register of dams into dam_register_reference (157; issue #326
// B-dams, docs/maps.md § Dams from the register and the map). The operator's
// tool, run as the schema owner (`pnpm import:dam-register`); the app only
// reads the table.
//
// Three inputs, any mix, joined by register number:
//  * JSON: `{ "dams": [{ registerNo, name, river, farm, lon, lat, capacityM3,
//    wallHeightM, surfaceAreaM2, completionYear, source }] }` (the committed
//    synthetic fixture's form; capacity in m³).
//  * CSV: the DWS Dam Safety Office's List of Registered Dams saved as CSV
//    (its columns "No of dam", "Name of dam", "River or Watercourse",
//    "Completion date", "Wall height (m)", "Capacity (1000 cub m)"; capacity
//    in thousands of m³, converted here). The list has no coordinates.
//  * KML: the same office's Google Earth overlay (the .kmz unzipped to its
//    doc.kml), one Placemark per dam with No_of_dam, Name_of_dam,
//    Lat_Decimal, Longitude_Decimal, Wall_height__m_ and Name_of_farm, or a
//    Point's coordinates. It gives each dam its position.
// A dam with no position after the join is skipped (listed). A load replaces
// every row of its dataset, in one transaction.
import type pg from 'pg';

export interface DamRecord {
	registerNo: string;
	name: string;
	river: string | null;
	farm: string | null;
	lon: number;
	lat: number;
	capacityM3: number | null;
	wallHeightM: number | null;
	surfaceAreaM2: number | null;
	completionYear: number | null;
	source: string;
}

/** What one input file says about a dam; the join fills the gaps from the others. */
export type DamPart = Partial<Omit<DamRecord, 'registerNo'>> & { registerNo: string };

/** A JSON or KML number (the overlay writes decimal degrees with a point; a lone comma is read as a decimal comma). The CSV's cells go through decimalMarkOf and numberWith below. */
const num = (v: unknown): number | null => {
	if (v === null || v === undefined) return null;
	const s = String(v).trim().replace(/\s/g, '');
	if (!s) return null;
	const n = Number(s.replace(',', '.'));
	return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// The CSV's numbers: decimal comma or decimal point (issue #886)
// ---------------------------------------------------------------------------
//
// A list saved from a South African spreadsheet may write 12,5 for twelve and
// a half, and one saved in another locale 1,234 for a thousand and more, so a
// comma alone doesn't say which it is. Spaces (SA's thousands separator) are
// dropped. Each number cell is read by its shape:
//  * a single comma not followed by exactly three digits (12,5), or dots
//    grouping thousands before a comma (1.234,5), or several dots grouping
//    thousands (1.234.567): the file uses a decimal comma;
//  * any dot that isn't one of those (12.5, -33.786, 1,234.5), or several
//    commas grouping thousands (1,234,567): the file uses a decimal point;
//  * one comma followed by exactly three digits, no dot (1,234): either.
// The file's convention is what its unambiguous cells show, over every number
// column, and settles the ambiguous ones. A file whose cells show both, or
// none while some cell is ambiguous, has those values refused (left empty and
// listed), never guessed: 1,234 read the wrong way is 1000 times off.
export type DecimalMark = 'comma' | 'point';

const DIGITS = /^[-+]?\d+$/;
const AMBIGUOUS = /^[-+]?\d{1,3},\d{3}$/;
const POINT_FORM = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^[-+]?\.\d+$/;
const COMMA_FORM = /^[-+]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$|^[-+]?,\d+$/;

/** A number cell with its spaces dropped. */
const squeeze = (v: unknown): string => (v === null || v === undefined ? '' : String(v).replace(/\s/g, ''));

/** Which decimal mark a cell's shape shows, 'ambiguous' for 1,234, or null for a cell that says nothing (empty, digits only, not a number). */
export function decimalMarkOf(v: unknown): DecimalMark | 'ambiguous' | null {
	const s = squeeze(v);
	if (!s || DIGITS.test(s)) return null;
	if (AMBIGUOUS.test(s)) return 'ambiguous';
	const point = POINT_FORM.test(s);
	const comma = COMMA_FORM.test(s);
	// A cell like 1.234 (one dot, three digits) fits both forms; a dot alone is read as a decimal point.
	if (point) return 'point';
	if (comma) return 'comma';
	return null;
}

/** A number cell read with the file's decimal mark: null when empty or not a number. */
export function numberWith(v: unknown, mark: DecimalMark): number | null {
	const s = squeeze(v);
	if (!s) return null;
	if (mark === 'point') return POINT_FORM.test(s) ? Number(s.replace(/,/g, '')) : null;
	return COMMA_FORM.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : null;
}

const text = (v: unknown, max: number): string | null => {
	const s = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
	return s ? s.slice(0, max) : null;
};
/** A register number as the list writes it (upper case, no spaces). */
export const registerNo = (v: unknown): string | null => {
	const s = String(v ?? '').replace(/\s+/g, '').toUpperCase();
	return s && s.length <= 20 ? s : null;
};
/** A completion year from the list's "Completion date" (a year, 0 for unknown, or a date). */
export const completionYear = (v: unknown): number | null => {
	const m = /(1[6-9]\d\d|2[01]\d\d)/.exec(String(v ?? ''));
	return m ? Number(m[1]) : null;
};
const nonNeg = (n: number | null): number | null => (n !== null && n >= 0 ? n : null);
const inRange = (lon: number | null, lat: number | null) => lon !== null && lat !== null && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;

/** The fixture's JSON form. */
export function damPartsFromJson(doc: unknown): { parts: DamPart[]; problems: string[] } {
	const dams = (doc as { dams?: unknown })?.dams;
	if (!Array.isArray(dams)) return { parts: [], problems: ['the JSON file has no "dams" array'] };
	const parts: DamPart[] = [];
	const problems: string[] = [];
	dams.forEach((d: Record<string, unknown>, i: number) => {
		const no = registerNo(d?.registerNo);
		if (!no) return problems.push(`dam ${i + 1}: no register number`);
		parts.push({
			registerNo: no,
			name: text(d.name, 200) ?? undefined,
			river: text(d.river, 200),
			farm: text(d.farm, 200),
			lon: num(d.lon) ?? undefined,
			lat: num(d.lat) ?? undefined,
			capacityM3: nonNeg(num(d.capacityM3)),
			wallHeightM: nonNeg(num(d.wallHeightM)),
			surfaceAreaM2: nonNeg(num(d.surfaceAreaM2)),
			completionYear: completionYear(d.completionYear),
			source: text(d.source, 500) ?? undefined
		});
	});
	return { parts, problems };
}

/** One CSV line's cells (double-quoted cells may hold commas and doubled quotes). */
export function csvCells(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cur += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out.map((s) => s.trim());
}

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMNS = {
	no: ['noofdam', 'damno', 'registerno', 'number'],
	name: ['nameofdam', 'name', 'damname'],
	river: ['riverorwatercourse', 'river', 'watercourse'],
	farm: ['nameoffarm', 'farm'],
	completed: ['completiondate', 'completionyear', 'completed'],
	wall: ['wallheightm', 'wallheight'],
	capacity1000: ['capacity1000cubm', 'capacity1000m3'],
	capacity: ['capacitym3'],
	area: ['surfaceaream2', 'surfacearea'],
	lat: ['latdecimal', 'lat', 'latitude'],
	lon: ['longitudedecimal', 'londecimal', 'lon', 'long', 'longitude']
} as const;
/** The columns read as numbers, whose cells settle the file's decimal mark. */
const NUMBER_COLUMNS = ['wall', 'capacity1000', 'capacity', 'area', 'lat', 'lon'] as const;

/** The DSO list saved as CSV (or any CSV with those columns). */
export function damPartsFromCsv(csv: string): { parts: DamPart[]; problems: string[] } {
	const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return { parts: [], problems: ['the CSV file is empty'] };
	const head = csvCells(lines[0]!).map(key);
	const col = (names: readonly string[]) => head.findIndex((h) => names.includes(h));
	const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, col(names)])) as Record<keyof typeof COLUMNS, number>;
	if (at.no < 0) return { parts: [], problems: ['the CSV file has no "No of dam" column'] };
	const parts: DamPart[] = [];
	const problems: string[] = [];
	const rows = lines.slice(1).map(csvCells);
	const headers = csvCells(lines[0]!);
	// The file's decimal mark, from every number cell's shape (above).
	const seen = new Set<DecimalMark | 'ambiguous'>();
	for (const cells of rows) for (const k of NUMBER_COLUMNS) if (at[k] >= 0) {
		const m = decimalMarkOf(cells[at[k]]);
		if (m) seen.add(m);
	}
	const mixed = seen.has('comma') && seen.has('point');
	const mark: DecimalMark | null = mixed ? null : seen.has('comma') ? 'comma' : seen.has('point') ? 'point' : null;
	if (mixed) problems.push('the CSV file writes decimals both with a comma (12,5) and with a point (12.5); save it again with one decimal mark');
	for (const [i, cells] of rows.entries()) {
		const get = (k: keyof typeof COLUMNS) => (at[k] >= 0 ? cells[at[k]] : undefined);
		const cell = (k: (typeof NUMBER_COLUMNS)[number]): number | null => {
			const v = get(k);
			const m = decimalMarkOf(v);
			if (m !== 'ambiguous') return numberWith(v, m ?? 'point');
			if (mark) return numberWith(v, mark);
			const why = mixed ? 'and the file’s other numbers disagree on which' : 'and no other number in the file says which';
			problems.push(
				`CSV row ${i + 2}: "${squeeze(v)}" in "${headers[at[k]]}" could be ${numberWith(v, 'point')} (a thousands comma) or ${numberWith(v, 'comma')} (a decimal comma), ${why}; left out (write it without the comma)`
			);
			return null;
		};
		const no = registerNo(get('no'));
		if (!no) {
			problems.push(`CSV row ${i + 2}: no register number`);
			continue;
		}
		const thousands = cell('capacity1000');
		parts.push({
			registerNo: no,
			name: text(get('name'), 200) ?? undefined,
			river: text(get('river'), 200),
			farm: at.farm >= 0 ? text(get('farm'), 200) : undefined,
			completionYear: completionYear(get('completed')),
			wallHeightM: nonNeg(cell('wall')),
			capacityM3: nonNeg(thousands !== null ? thousands * 1000 : cell('capacity')),
			surfaceAreaM2: nonNeg(cell('area')),
			lat: cell('lat') ?? undefined,
			lon: cell('lon') ?? undefined
		});
	}
	return { parts, problems };
}

const decode = (s: string) =>
	s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');

/** The DSO's Google Earth overlay (doc.kml): each Placemark's register number, name, farm, wall height and position. */
export function damPartsFromKml(kml: string): { parts: DamPart[]; problems: string[] } {
	const parts: DamPart[] = [];
	const problems: string[] = [];
	const placemarks = kml.match(/<Placemark\b[\s\S]*?<\/Placemark>/g) ?? [];
	if (!placemarks.length) return { parts, problems: ['the KML file has no Placemark'] };
	placemarks.forEach((p, i) => {
		const data = new Map<string, string>();
		for (const m of p.matchAll(/<(?:SimpleData|Data)\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:SimpleData|Data)>/g)) {
			const v = /<value>([\s\S]*?)<\/value>/.exec(m[2]!)?.[1] ?? m[2]!;
			data.set(key(m[1]!), decode(v).trim());
		}
		const no = registerNo(data.get('noofdam'));
		if (!no) return problems.push(`placemark ${i + 1}: no No_of_dam`);
		const coords = /<coordinates>\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/.exec(p);
		const lat = num(data.get('latdecimal')) ?? (coords ? num(coords[2]) : null);
		const lon = num(data.get('longitudedecimal')) ?? (coords ? num(coords[1]) : null);
		const name = data.get('nameofdam') ?? decode(/<name>([\s\S]*?)<\/name>/.exec(p)?.[1] ?? '');
		parts.push({
			registerNo: no,
			name: text(name, 200) ?? undefined,
			farm: text(data.get('nameoffarm'), 200),
			wallHeightM: nonNeg(num(data.get('wallheightm'))),
			lat: lat ?? undefined,
			lon: lon ?? undefined
		});
	});
	return { parts, problems };
}

/**
 * Join the parts by register number (a later part fills only what earlier
 * ones left empty, so put the list before the overlay), keeping each dam
 * with a name and a position. The source is the part's own, else
 * `defaultSource` with the register number appended.
 */
export function joinDamParts(parts: readonly DamPart[], defaultSource: string): { records: DamRecord[]; problems: string[] } {
	const byNo = new Map<string, DamPart>();
	for (const p of parts) {
		const was = byNo.get(p.registerNo) ?? { registerNo: p.registerNo };
		const merged: DamPart = { ...was };
		for (const [k, v] of Object.entries(p) as [keyof DamPart, unknown][]) {
			if (v !== undefined && v !== null && (merged[k] === undefined || merged[k] === null)) (merged as Record<string, unknown>)[k] = v;
		}
		byNo.set(p.registerNo, merged);
	}
	const records: DamRecord[] = [];
	const problems: string[] = [];
	for (const p of byNo.values()) {
		if (!p.name) {
			problems.push(`${p.registerNo}: no name`);
			continue;
		}
		if (!inRange(p.lon ?? null, p.lat ?? null)) {
			problems.push(`${p.registerNo} (${p.name}): no position (the list has none; give the overlay's KML too)`);
			continue;
		}
		const source = p.source ?? (defaultSource ? `${defaultSource}: ${p.registerNo}`.slice(0, 500) : null);
		if (!source) {
			problems.push(`${p.registerNo} (${p.name}): no source (pass --source)`);
			continue;
		}
		records.push({
			registerNo: p.registerNo,
			name: p.name,
			river: p.river ?? null,
			farm: p.farm ?? null,
			lon: p.lon!,
			lat: p.lat!,
			capacityM3: p.capacityM3 ?? null,
			wallHeightM: p.wallHeightM ?? null,
			surfaceAreaM2: p.surfaceAreaM2 ?? null,
			completionYear: p.completionYear ?? null,
			source
		});
	}
	records.sort((a, b) => a.registerNo.localeCompare(b.registerNo));
	return { records, problems };
}

/** Replace every row of `dataset` with `records`, in one transaction, as the schema owner. Returns how many rows it wrote. */
export async function replaceDamDataset(client: pg.ClientBase, dataset: string, records: readonly DamRecord[]): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM dam_register_reference WHERE dataset = $1', [dataset]);
		for (const r of records) {
			await client.query(
				`INSERT INTO dam_register_reference (register_no, dataset, name, river, farm, lon, lat, capacity_m3, wall_height_m, surface_area_m2, completion_year, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
				 ON CONFLICT (register_no) DO UPDATE SET dataset = EXCLUDED.dataset, name = EXCLUDED.name, river = EXCLUDED.river,
					farm = EXCLUDED.farm, lon = EXCLUDED.lon, lat = EXCLUDED.lat, capacity_m3 = EXCLUDED.capacity_m3,
					wall_height_m = EXCLUDED.wall_height_m, surface_area_m2 = EXCLUDED.surface_area_m2,
					completion_year = EXCLUDED.completion_year, source = EXCLUDED.source, loaded_at = now()`,
				[r.registerNo, dataset, r.name, r.river, r.farm, r.lon, r.lat, r.capacityM3, r.wallHeightM, r.surfaceAreaM2, r.completionYear, r.source]
			);
		}
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
