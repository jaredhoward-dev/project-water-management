// The uncertainty panel's monthly flow-duration chart, rendered to HTML with
// Svelte's server renderer: its numbers behind "Show the numbers", the drawing
// in a box that scrolls on a phone (its labels never scale under 9.5 px), and
// no chart at all for an ensemble served as EWR counts and rates only, whose
// curves are withheld (`fdc: []`, #523 I), which threw until then. The browser
// side is pinned by e2e/tests/uncertainty.spec.ts.
import { band } from '@water-management/engine';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BandFdcChart from './BandFdcChart.svelte';
import TornadoChart from './TornadoChart.svelte';

const points = [5, 50, 95];
const fdc = [
	{ month: 10, ewrM3Day: 100, points: [band(Array.from({ length: 30 }, () => 1000)), band(Array.from({ length: 30 }, () => 100)), band(Array.from({ length: 30 }, () => 10))] },
	{ month: 11, ewrM3Day: 50, points: [band(Array.from({ length: 30 }, () => 900)), band(Array.from({ length: 30 }, () => 90)), band(Array.from({ length: 30 }, () => 9))] }
];

describe('BandFdcChart', () => {
	it("gives the month's band at every exceedance point as a table", () => {
		const html = render(BandFdcChart, { props: { fdc, points } }).body;
		expect(html).toContain('Show the numbers');
		expect(html).toMatch(/<caption[^>]*>Oct simulated outflow at each exceedance point, m³\/day, against the EWR of 100 m³\/day<\/caption>/);
		const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
		expect(body.match(/<tr/g)).toHaveLength(3);
		expect(body).toContain('5 % of days');
		expect(body).toContain('95 % of days');
		expect(body).toContain('1 000');
	});

	it('draws in a scroll region, so a phone scrolls it rather than shrinking its labels', () => {
		const html = render(BandFdcChart, { props: { fdc, points } }).body;
		expect(html).toMatch(/<div class="scroll[^"]*" data-scroll-region[^>]*>\s*<svg/);
	});

	it('renders nothing for a band whose curves are withheld', () => {
		const html = render(BandFdcChart, { props: { fdc: [], points } }).body;
		expect(html).not.toContain('<svg');
		expect(html).not.toContain('Show the numbers');
	});
});

describe('TornadoChart', () => {
	it('draws in a scroll region, so a phone scrolls it rather than shrinking its labels', () => {
		const rows = [{ factor: 'rain', label: 'Rain', lowLabel: '−10 %', highLabel: '+10 %', low: 12, high: 4, swing: 8 }];
		const html = render(TornadoChart, { props: { title: 'EWR days not met at Outlet, days, by sensitivity factor', rows: rows as never, central: 8, metric: 'daysNotMet' } }).body;
		expect(html).toMatch(/<div class="scroll[^"]*" data-scroll-region[^>]*>\s*<svg/);
	});
});
