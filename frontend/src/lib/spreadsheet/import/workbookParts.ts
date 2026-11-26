// The two small parts the reader needs before any sheet: workbook.xml (the
// sheets, the defined names and the date system) and styles.xml (enough of
// it to give each cell style its number format, which is how a date cell is
// told from a number). workbook.xml is read the way SheetJS read it, so a
// sheet or named range resolves exactly as before; styles.xml the way
// openpyxl 3.1.5 reads it, since the Python importer decides date vs number
// (issue #895).
import { pyInt } from './cells';
import { decodeXml } from './ooxml';
import type { DefinedName } from './source';
import { UnreadableWorkbookError } from './errors';
import { notWellFormed, parseXmlBool, scanXml, type Tag, binary, unescapeXml, utf8read } from './xml';

/** The SpreadsheetML namespaces SheetJS accepts on <workbook> (transitional, strict and two legacy ones). */
const MAIN_NAMESPACES = [
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
	'http://schemas.microsoft.com/office/excel/2006/main',
	'http://schemas.microsoft.com/office/excel/2006/2'
];

export interface WorkbookXml {
	/** Sheets in workbook order: name (decoded as SheetJS decodes it) and relationship id. */
	sheets: { name: string; rid: string | undefined }[];
	names: DefinedName[];
	date1904: boolean;
}

function qname(tag: Tag): string {
	return binary(tag.buf, tag.start + 1, tag.nameEnd);
}

/** Read xl/workbook.xml. */
export function readWorkbookXml(bytes: Uint8Array, part: string): WorkbookXml {
	const out: WorkbookXml = { sheets: [], names: [], date1904: false };
	let namespace = '';
	let name: { name: string; local: boolean; raw: string[] } | null = null;
	scanXml(bytes, part, {
		open(local, tag, selfClosing) {
			if (name) throw notWellFormed(part, 'a defined name has markup inside it');
			if (local === 'workbook') {
				const q = qname(tag);
				const c = q.indexOf(':');
				const want = c === -1 ? 'xmlns' : `xmlns:${q.slice(0, c)}`;
				namespace = tag.attributes().find(([k]) => k === want)?.[1] ?? '';
			} else if (local === 'workbookPr') {
				const v = tag.attr('date1904');
				if (v !== undefined) out.date1904 = parseXmlBool(v);
			} else if (local === 'sheet') {
				const n = tag.attr('name');
				if (n === undefined) throw new UnreadableWorkbookError('a sheet in it has no name', 'corrupt');
				const rid = tag.attr('id');
				out.sheets.push({ name: unescapeXml(utf8read(n)), rid: rid === undefined ? undefined : decodeXml(rid) });
			} else if (local === 'definedName' && !selfClosing) {
				const n = tag.attr('name');
				if (n === undefined) throw new UnreadableWorkbookError('a defined name in it has no name', 'corrupt');
				// SheetJS: Name as written (not unescaped); sheet-scoped when localSheetId is non-empty.
				name = { name: utf8read(n), local: Boolean(tag.attr('localSheetId')), raw: [] };
			}
		},
		close(local) {
			if (local === 'definedName' && name) {
				out.names.push({ name: name.name, ref: unescapeXml(utf8read(name.raw.join(''))), local: name.local });
				name = null;
			}
		},
		text(buf, start, end) {
			name?.raw.push(binary(buf, start, end));
		},
		cdata(buf, start, end) {
			name?.raw.push(`<![CDATA[${binary(buf, start, end)}]]>`);
		},
		markup(buf, start, end) {
			name?.raw.push(binary(buf, start, end));
		}
	});
	if (!MAIN_NAMESPACES.includes(namespace)) throw new UnreadableWorkbookError(`its workbook part is in an unknown namespace${namespace ? ` (${namespace})` : ''}`, 'not-workbook');
	return out;
}

/**
 * The built-in number formats, by id: openpyxl 3.1.5's BUILTIN_FORMATS
 * (openpyxl/styles/numbers.py; the version scripts/wbt-import/requirements.txt
 * pins), verbatim. openpyxl decides date vs number from this table keyed by
 * the cell style's numFmtId (Stylesheet._normalise_numbers), so the browser
 * reader uses the same one. It is not SheetJS's SSF table, which this reader
 * otherwise follows: SheetJS also has id 56, a time format, that openpyxl
 * lacks, so a cell styled with it is a number in Python (issue #895); its
 * other differences (5–8, 37–44, 14's spelling) never change date vs number.
 * An id in neither the table nor the workbook's own formats has no format:
 * a number, as in openpyxl. Re-check this table when the openpyxl pin moves.
 */
const BUILTIN_FORMATS: [number, string][] = [
	[0, 'General'],
	[1, '0'],
	[2, '0.00'],
	[3, '#,##0'],
	[4, '#,##0.00'],
	[5, '"$"#,##0_);("$"#,##0)'],
	[6, '"$"#,##0_);[Red]("$"#,##0)'],
	[7, '"$"#,##0.00_);("$"#,##0.00)'],
	[8, '"$"#,##0.00_);[Red]("$"#,##0.00)'],
	[9, '0%'],
	[10, '0.00%'],
	[11, '0.00E+00'],
	[12, '# ?/?'],
	[13, '# ??/??'],
	[14, 'mm-dd-yy'],
	[15, 'd-mmm-yy'],
	[16, 'd-mmm'],
	[17, 'mmm-yy'],
	[18, 'h:mm AM/PM'],
	[19, 'h:mm:ss AM/PM'],
	[20, 'h:mm'],
	[21, 'h:mm:ss'],
	[22, 'm/d/yy h:mm'],
	[37, '#,##0_);(#,##0)'],
	[38, '#,##0_);[Red](#,##0)'],
	[39, '#,##0.00_);(#,##0.00)'],
	[40, '#,##0.00_);[Red](#,##0.00)'],
	[41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'],
	[42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'],
	[43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'],
	[44, '_("$"* #,##0.00_)_("$"* \\(#,##0.00\\)_("$"* "-"??_)_(@_)'],
	[45, 'mm:ss'],
	[46, '[h]:mm:ss'],
	[47, 'mmss.0'],
	[48, '##0.0E+0'],
	[49, '@']
];

/**
 * Cell style → number format, as openpyxl 3.1.5 resolves it (issue #895):
 * a cell's s attribute is read with Python's int() (no s is style 0) and
 * names a cellXfs <xf>; the xf's numFmtId (0 when absent) is looked up in the
 * workbook's own formats first, any id (0 included, past 0x188 as written),
 * then in BUILTIN_FORMATS. A style index out of range, or an id in neither
 * table, has no format: a number. Where styles.xml repeats <numFmts> or
 * <cellXfs>, the last block counts, as in openpyxl. openpyxl refuses an s, a
 * numFmtId or a numFmt id that int() can't read; so does this.
 */
export class Styles {
	private readonly cache = new Map<string, number>();
	/** Distinct format strings (undefined = no format), indexed by zIndex(). */
	readonly formats: (string | undefined)[] = [];
	private readonly formatIndex = new Map<string | undefined, number>();

	constructor(
		private readonly table: Map<number, string>,
		/** Each cellXfs <xf>'s numFmtId; empty without a <cellXfs>. */
		private readonly xfs: number[]
	) {}

	/** The number format of a cell whose s attribute is `s` (raw), or undefined. */
	format(s: string | undefined): string | undefined {
		const i = s === undefined ? 0 : pyInt(s);
		if (i === null) throw new UnreadableWorkbookError(`a cell style index in it is not a number (${s!.slice(0, 20)})`, 'corrupt');
		if (i < 0 || i >= this.xfs.length) return undefined;
		return this.table.get(this.xfs[i]!);
	}

	/** format(s) as an index into `formats`, cached per distinct s. */
	zIndex(s: string | undefined): number {
		const key = s ?? '\u0000';
		let i = this.cache.get(key);
		if (i === undefined) {
			const z = this.format(s);
			i = this.formatIndex.get(z);
			if (i === undefined) {
				i = this.formats.length;
				this.formats.push(z);
				this.formatIndex.set(z, i);
			}
			this.cache.set(key, i);
		}
		return i;
	}
}

/** No styles part: no cell has a format. */
export function defaultStyles(): Styles {
	return new Styles(new Map(BUILTIN_FORMATS), []);
}

function formatId(raw: string, what: string): number {
	const id = pyInt(raw);
	if (id === null) throw new UnreadableWorkbookError(`a ${what} in it is not a number (${raw.slice(0, 20)})`, 'corrupt');
	return id;
}

/**
 * Read xl/styles.xml as openpyxl does for dates: the last <numFmts> block's
 * formats by id and the last <cellXfs> block's <xf numFmtId>.
 */
export function readStyles(bytes: Uint8Array, part: string): Styles {
	let numFmts: { id: string | undefined; code: string | undefined }[] = [];
	let xfIds: (string | undefined)[] = [];
	let inNumFmts = -1;
	let inXfs = -1;
	let depth = 0;
	scanXml(bytes, part, {
		open(local, tag, selfClosing) {
			if (local === 'numFmts') {
				numFmts = [];
				if (!selfClosing) inNumFmts = depth;
			} else if (local === 'cellXfs') {
				xfIds = [];
				if (!selfClosing) inXfs = depth;
			} else if (local === 'numFmt' && inNumFmts >= 0) numFmts.push({ id: tag.attr('numFmtId'), code: tag.attr('formatCode') });
			else if (local === 'xf' && inXfs >= 0) xfIds.push(tag.attr('numFmtId'));
			depth++;
		},
		close() {
			depth--;
			if (depth === inNumFmts) inNumFmts = -1;
			if (depth === inXfs) inXfs = -1;
		},
		text() {},
		cdata() {}
	});

	const table = new Map(BUILTIN_FORMATS);
	for (const f of numFmts) {
		if (f.code === undefined) throw new UnreadableWorkbookError('a number format in it has no format code', 'corrupt');
		if (f.id === undefined) throw new UnreadableWorkbookError('a number format in it has no id', 'corrupt');
		table.set(formatId(unescapeXml(utf8read(f.id)), 'number format id'), unescapeXml(utf8read(f.code)));
	}
	const xfs = xfIds.map((raw) => (raw === undefined ? 0 : formatId(unescapeXml(utf8read(raw)), 'cell style numFmtId')));
	return new Styles(table, xfs);
}
