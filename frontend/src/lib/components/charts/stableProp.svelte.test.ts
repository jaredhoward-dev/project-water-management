import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { alignDaily, type ChartSeries } from './series';
import { copyData, sameData, stableProp } from './stableProp';

describe('sameData and copyData', () => {
	it('compares plain data by content', () => {
		expect(sameData([{ start: '2020-01-01', end: '2020-01-02' }], [{ start: '2020-01-01', end: '2020-01-02' }])).toBe(true);
		expect(sameData([{ start: '2020-01-01', end: '2020-01-02' }], [{ start: '2020-01-01', end: '2020-01-03' }])).toBe(false);
		expect(sameData({ a: [1, null, 3] }, { a: [1, null, 3] })).toBe(true);
		expect(sameData({ a: [1, null, 3] }, { a: [1, 0, 3] })).toBe(false);
		expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
		expect(sameData([], {})).toBe(false);
		expect(sameData(undefined, undefined)).toBe(true);
		expect(sameData(NaN, NaN)).toBe(true);
	});

	it('copies arrays and objects all the way down', () => {
		const v = { label: 'x', values: [1, 2], ranges: [{ start: 'a', end: 'b' }] };
		const c = copyData(v);
		expect(c).toEqual(v);
		expect(c.values).not.toBe(v.values);
		expect(c.ranges[0]).not.toBe(v.ranges[0]);
	});
});

// The Series tab's pattern: `values` is replaced whole as each series arrives, and the chart's inline
// `series={[{ … values: values[viewing.id].values }]}` re-evaluates every time, a new array with the same content.
describe('stableProp in a chart', () => {
	function harness(keep: boolean) {
		const day = (n: number) => ({ startDate: '2000-01-01', values: Array.from({ length: n }, (_, i) => i) });
		const state = $state({ values: { a: day(1000) } as Record<string, ReturnType<typeof day>> });
		let builds = 0;
		const keepSeries = stableProp<ChartSeries[]>();
		const stop = $effect.root(() => {
			const seriesIn = $derived<ChartSeries[]>([{ label: 'A', startDate: state.values.a!.startDate, values: state.values.a!.values }]);
			const series = $derived(keep ? keepSeries(seriesIn) : seriesIn);
			// The chart's rebuild: alignDaily over the record, then uPlot.
			$effect(() => {
				void alignDaily(series);
				builds++;
			});
		});
		flushSync();
		return { state, day, builds: () => builds, stop };
	}

	it('builds once while other series arrive, where it built once per arrival', () => {
		for (const keep of [false, true]) {
			const h = harness(keep);
			for (let i = 0; i < 20; i++) {
				h.state.values = { ...h.state.values, [`s${i}`]: h.day(1000) };
				flushSync();
			}
			expect(h.builds()).toBe(keep ? 1 : 21);
			h.stop();
		}
	});

	it('still rebuilds when the charted record changes, a new record or one edited in place', () => {
		const h = harness(true);
		h.state.values = { ...h.state.values, a: h.day(1001) };
		flushSync();
		expect(h.builds()).toBe(2);
		// A $state proxy array edited in place: the same object, new content.
		h.state.values.a!.values[5] = 99;
		flushSync();
		expect(h.builds()).toBe(3);
		h.stop();
	});
});
