// Keeps a chart prop's identity while its content stays the same.
//
// Callers pass LineChart its series, shade, lanes and band as inline expressions (`series={[{ … values: values[id].values }]}`),
// which Svelte re-evaluates whenever anything they read changes, handing the chart a new array with the same
// content. The chart rebuilt on every new array (alignDaily over the whole record, then a uPlot destroy and redraw):
// the Series tab redrew its chart once for every series whose values arrived while it loaded. Passing each prop
// through `stableProp` hands the chart the same object until the content changes (docs/ui.md § Series tab performance).

type Data = unknown;

/** Structural equality over plain data: primitives by Object.is, arrays element by element, plain objects key by key. */
export function sameData(a: Data, b: Data): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
		return true;
	}
	if (Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
		if (!sameData((a as Record<string, Data>)[k], (b as Record<string, Data>)[k])) return false;
	}
	return true;
}

/** A plain copy of plain data (arrays and objects copied, everything else as is): never a Svelte state proxy. */
export function copyData<T>(v: T): T {
	if (Array.isArray(v)) return v.map(copyData) as T;
	if (typeof v === 'object' && v !== null) {
		const out: Record<string, Data> = {};
		for (const k of Object.keys(v)) out[k] = copyData((v as Record<string, Data>)[k]);
		return out as T;
	}
	return v;
}

/**
 * A function that returns the value it returned last time while each new value has the same content, and a plain
 * copy of the new value when the content changed. It compares against its own copy, so a caller that mutates an
 * array in place (a `$state` proxy) still reads as a change, and reading the value through it tracks every field
 * the comparison reads, as the chart's own reads did.
 */
export function stableProp<T>(): (next: T) => T {
	let held: { copy: T } | null = null;
	return (next) => {
		if (held && sameData(next, held.copy)) return held.copy;
		held = { copy: copyData(next) };
		return held.copy;
	};
}
