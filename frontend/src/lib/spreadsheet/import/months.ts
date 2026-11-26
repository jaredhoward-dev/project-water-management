// b023 month-list cells ("1,2,11,12"), docs/engine-audit.md M1.
//
// The workbook tests a month with ISNUMBER(FIND(m & ",", list & ",")), a
// substring search, so "11" also switches on January and "12" February. That
// is a workbook bug, not what the author wrote: the importer keeps the listed
// months only and names what the workbook would have added.
//
// Ported from extract_project.py's month_list() (transfer months), which
// finds the numbers in the cell text as written. (The legacy runoff model's
// summer months, read with the spaces removed, went with it in engine 1.0.0.)
import { type Cell, pyStr } from './cells';

function cellText(v: Cell): string {
	// str(int(v)) for a whole float, else str(v). A whole number past 1e16 is all its digits here, where pyStr would write 1e+16 (issue #895).
	if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v).toString();
	return pyStr(v);
}

/**
 * int() of a run of Python's \\d: any Unicode decimal digit (Nd). Nd digits
 * come in runs of ten from 0 to 9, so a digit's value is its distance from
 * the start of its run, mod 10.
 */
function digitsValue(run: string): number {
	let n = 0;
	for (const ch of run) {
		const cp = ch.codePointAt(0)!;
		let d = cp - 48;
		if (d < 0 || d > 9) {
			let start = cp;
			while (ND.test(String.fromCodePoint(start - 1))) start--;
			d = (cp - start) % 10;
		}
		n = n * 10 + d;
	}
	return n;
}

const ND = /^\p{Nd}$/u;

function listed(text: string): number[] {
	const months = new Set<number>();
	for (const m of text.match(/\p{Nd}+/gu) ?? []) {
		const n = digitsValue(m);
		if (n >= 1 && n <= 12) months.add(n);
	}
	return [...months].sort((a, b) => a - b);
}

function substringMatched(text: string): Set<number> {
	const t = `${text},`;
	const out = new Set<number>();
	for (let m = 1; m <= 12; m++) if (t.includes(`${m},`)) out.add(m);
	return out;
}

/** extract_project.py month_list(): the months a transfer's month-list cell names. */
export function monthList(v: Cell): number[] {
	return v === null ? [] : listed(cellText(v));
}

/** extract_project.py substring_extra_months(): months the workbook's FIND matches although the transfer list doesn't name them. */
export function substringExtraMonths(v: Cell): number[] {
	if (v === null) return [];
	const named = new Set(monthList(v));
	return [...substringMatched(cellText(v).replace(/ /g, ''))].filter((m) => !named.has(m)).sort((a, b) => a - b);
}
