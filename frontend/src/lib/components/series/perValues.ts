// Per-record memo for the Series tab's derived tables (coverage stats, coverage bins, data checks).
//
// The tab's `values` map is replaced whole as each series' values arrive (SeriesTab.svelte loadValues), so a
// derived that maps over every series re-ran for all of them on every arrival: loading N series computed each
// series' stats, bins and checks up to N times, O(N²) passes over 40-year daily records (30 series: about 4.5 s of
// main-thread work, against 0.3 s computed once each; docs/ui.md § Series tab performance). A values object is
// never mutated once it lands (an edit or upload loads a new one), so its identity keys the result.

/**
 * Wrap `compute(values, ...args)` so it runs once per values object and argument list: the same object with the
 * same arguments (compared with ===) returns the result it gave before. A new values object, or a changed argument
 * (the data-quality limits, the CHIRPS record a check reads), computes again. Held weakly: a record dropped from the
 * tab is dropped from the memo.
 */
export function perValues<V extends object, A extends unknown[], R>(compute: (values: V, ...args: A) => R): (values: V, ...args: A) => R {
	const memo = new WeakMap<V, { args: A; result: R }>();
	return (values, ...args) => {
		const hit = memo.get(values);
		if (hit && hit.args.length === args.length && hit.args.every((a, i) => a === args[i])) return hit.result;
		const result = compute(values, ...args);
		memo.set(values, { args, result });
		return result;
	};
}
