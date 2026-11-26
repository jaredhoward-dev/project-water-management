import { describe, expect, it } from 'vitest';
import { farmDrawerHref, feedCardClosedHref, hrefWith, nodeSheetHref, seriesPickHref } from './tabUrl';

const at = (s: string) => new URL(s, 'https://example.test');
const query = (href: string) => Object.fromEntries(new URLSearchParams(href.split('?')[1]?.split('#')[0] ?? ''));

describe('hrefWith', () => {
	it('sets and removes parameters, keeping the rest, the path and the fragment', () => {
		expect(hrefWith(at('/projects/p?tab=series&series=a#data-feeds'), { series: 'b', rain: null })).toBe('/projects/p?tab=series&series=b#data-feeds');
	});
	it('leaves no bare ? when the last parameter goes', () => {
		expect(hrefWith(at('/projects/p?rain=units'), { rain: null })).toBe('/projects/p');
	});
	it('is a no-op for a parameter that is not there', () => {
		expect(hrefWith(at('/projects/p?tab=network'), { section: null })).toBe('/projects/p?tab=network');
	});
});

describe('seriesPickHref', () => {
	it('drops view=, rain= and feed= with the pick, keeping the tab and other parameters', () => {
		const href = seriesPickHref(at('/projects/p?tab=series&series=a&view=2020-01-01~2020-02-01&rain=units&feed=dws&preview=all'), 'b');
		expect(query(href)).toEqual({ tab: 'series', series: 'b', preview: 'all' });
	});
});

describe('feedCardClosedHref', () => {
	it('removes the card’s arrival parameters only', () => {
		expect(feedCardClosedHref(at('/projects/p?tab=series&rain=boundary&series=a#data-feeds'))).toBe('/projects/p?tab=series&series=a#data-feeds');
		expect(feedCardClosedHref(at('/projects/p?tab=series&feed=agera5_et0'))).toBe('/projects/p?tab=series');
	});
});

describe('nodeSheetHref', () => {
	it('builds on the current URL: the other parameters stay, the node edited is picked, the grid gives way', () => {
		const href = nodeSheetHref(at('/projects/p?tab=network&grid=nodes&layer=supply&node=x'), 'n1', 'routing');
		expect(query(href)).toEqual({ tab: 'network', layer: 'supply', node: 'n1', edit: 'n1', section: 'routing' });
	});
	it('drops a stale section when none is asked for', () => {
		expect(query(nodeSheetHref(at('/projects/p?tab=network&section=demand'), 'n1'))).toEqual({ tab: 'network', edit: 'n1', node: 'n1' });
	});
});

describe('farmDrawerHref', () => {
	it('swaps the sheet (edit= and its section=) for the farm drawer', () => {
		expect(query(farmDrawerHref(at('/projects/p?tab=network&edit=n1&node=n1&section=irrigation'), 'n1'))).toEqual({ tab: 'network', node: 'n1', farm: 'n1' });
	});
});
