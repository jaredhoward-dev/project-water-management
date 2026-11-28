import { describe, expect, it } from 'vitest';
import { coverageStats, type Daily } from './coverage';
import { perValues } from './perValues';

const rec = (n: number): Daily => ({ startDate: '2000-01-01', values: Array.from({ length: n }, (_, i) => (i % 7 ? i : null)) });

describe('perValues', () => {
	it('computes each record once while the Series tab loads N series one at a time (was N(N+1)/2)', () => {
		// The tab replaces `values` as each series arrives and re-derives the stats over every series it has.
		const N = 30;
		const list = Array.from({ length: N }, (_, i) => ({ id: `s${i}`, kind: 'rain_catchment_mm', v: rec(100 + i) }));
		let calls = 0;
		const statsOf = perValues((v: Daily, kind: string) => {
			calls++;
			return coverageStats(v, kind);
		});
		let values: Record<string, Daily> = {};
		let last: Record<string, unknown> = {};
		for (const s of list) {
			values = { ...values, [s.id]: s.v };
			last = Object.fromEntries(list.map((x) => [x.id, values[x.id] ? statsOf(values[x.id]!, x.kind) : null]));
		}
		expect(calls).toBe(N);
		// Same answers as computing directly.
		for (const s of list) expect(last[s.id]).toEqual(coverageStats(s.v, s.kind));
	});

	it('computes again for a new values object or a changed argument, and returns the held result otherwise', () => {
		let calls = 0;
		const f = perValues((v: Daily, limits: object, chirps: Daily | null) => {
			calls++;
			return { n: v.values.length, limits, chirps };
		});
		const a = rec(10);
		const limits = { outlier: 3 };
		const first = f(a, limits, null);
		expect(f(a, limits, null)).toBe(first);
		expect(calls).toBe(1);
		// New limits (the project's data-quality settings changed).
		f(a, { outlier: 4 }, null);
		expect(calls).toBe(2);
		// A CHIRPS record arrived for the check to read.
		const chirps = rec(10);
		f(a, { outlier: 4 }, chirps);
		expect(calls).toBe(3);
		// An edit loads a new object for the same series: never the stale result.
		const edited = { ...a, values: [...a.values, 1] };
		expect(f(edited, limits, null).n).toBe(11);
		expect(calls).toBe(4);
	});
});
