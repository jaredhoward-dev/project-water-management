// Names in the workbook are user-controlled (farm, crop and run names), and
// the file is opened by other members of the project, so they get the same
// treatment as the CSV exports (docs/security.md "CSV exports defuse
// spreadsheet formulas") and fit Excel's sheet-name rules.

/**
 * Where a spreadsheet may read a cell as a formula (OWASP "CSV injection"):
 * a leading `= + - @` (or a full-width `＝ ＋ － ＠`, a formula in some
 * locales), the same after leading whitespace (LibreOffice Calc's CSV import
 * with "Trim spaces" on evaluates ` =1+1`; docs/security.md, issue #902), or a
 * leading tab, CR or LF. One rule, kept in step with backend/src/export/csv.ts
 * `FORMULA_START`.
 */
export const FORMULA_START = /^(?:[\t\r\n]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/;

/**
 * Text that a spreadsheet would treat as a formula (FORMULA_START) gets a
 * leading apostrophe, exactly like backend/src/export/csv.ts `textCell`. The
 * workbook writes every name as a string cell, which Excel never evaluates;
 * the apostrophe keeps it inert if someone edits the cell or copies it into a
 * CSV.
 */
export function defuse(text: string): string {
	return FORMULA_START.test(text) ? `'${text}` : text;
}

/**
 * A `;` that a formula trigger follows. Excel in a comma-decimal locale (South
 * Africa's among them) and LibreOffice with `;` as its separator split a CSV
 * on `;`, so the text after one is a cell of its own, quoted or not:
 * `Farm;=SUM(4)` computes 4 there (docs/security.md "CSV exports defuse
 * spreadsheet formulas"). One rule with backend/src/export/csv.ts
 * `SEPARATOR_FORMULA`.
 */
export const SEPARATOR_FORMULA = /;(?=[\t\r\n]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/g;
const DEFUSED_SEPARATOR = /;'(?=[\t\r\n]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/g;

/**
 * A CSV text cell's guard (before RFC 4180 quoting), exactly like the
 * backend's `textCell`: `defuse`, and an apostrophe after each `;` that a
 * trigger follows (`a;=b` → `a;'=b`). Only for CSV: a workbook's cells aren't
 * split on `;`, so the workbook keeps `defuse`.
 */
export function defuseCsv(text: string): string {
	return defuse(text).replace(SEPARATOR_FORMULA, ";'");
}

/**
 * Read a defused cell back: the apostrophe `defuse` (or the backend's
 * `textCell`) added is dropped, any other kept, and so is the one
 * `defuseCsv` put after a `;`.
 */
export function undefuse(text: string): string {
	const s = text.startsWith("'") && FORMULA_START.test(text.slice(1)) ? text.slice(1) : text;
	return s.replace(DEFUSED_SEPARATOR, ';');
}

/** Longest sheet name Excel accepts. */
export const SHEET_NAME_MAX = 31;

/**
 * A sheet-name allocator: each call returns a name Excel accepts for `wanted`
 * (at most 31 characters, none of `[ ] : * ? / \`, no control characters, no
 * leading or trailing apostrophe, not the reserved "History") and unique
 * within the workbook, ignoring case as Excel does ("Farm", "Farm (2)", …).
 */
export function sheetNamer(): (wanted: string) => string {
	const taken = new Set<string>();
	return (wanted) => {
		let base = wanted
			.replace(/[[\]:*?/\\]/g, '_')
			.replace(/[\u0000-\u001f\u007f]/g, ' ')
			.trim()
			.replace(/^'+|'+$/g, '')
			.trim();
		if (!base) base = 'Sheet';
		if (base.toLowerCase() === 'history') base = 'History_';
		for (let n = 1; ; n++) {
			const suffix = n === 1 ? '' : ` (${n})`;
			const name = cut(base, SHEET_NAME_MAX - suffix.length).replace(/'+$/, '') + suffix;
			if (!taken.has(name.toLowerCase())) {
				taken.add(name.toLowerCase());
				return name;
			}
		}
	};
}

/** The first `max` UTF-16 units of `s`, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
	let out = '';
	for (const ch of s) {
		if (out.length + ch.length > max) break;
		out += ch;
	}
	return out;
}
