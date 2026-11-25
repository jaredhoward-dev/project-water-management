import { describe, expect, it } from 'vitest';
import { panelZoneFor, priorDonorsMapHref, priorPanelHref, priorZoneFromUrl, routeZoneOf } from './priorLinks';

const query = (href: string) => new URLSearchParams(href.replace(/^\?/, '').split('#')[0]);

describe('the prior’s links between the Calibration page and the Map (priorZone)', () => {
	it('carries the target both ways: a zone, the outlet’s own zone, or none for the headline', () => {
		for (const zone of ['node-7', 'outlet', 'n&1 x', null]) {
			const map = priorDonorsMapHref(zone);
			expect(query(map).get('tab')).toBe('map');
			expect(query(map).get('layers')).toBe('donors');
			expect(priorZoneFromUrl(query(map))).toBe(zone);
			const back = priorPanelHref(priorZoneFromUrl(query(map)));
			expect(back.endsWith('#set-prior')).toBe(true);
			expect(query(back).get('tab')).toBe('calibration');
			expect(priorZoneFromUrl(query(back))).toBe(zone);
		}
		expect(priorDonorsMapHref(null)).toBe('?tab=map&layers=donors');
		expect(priorPanelHref('n1')).toBe('?tab=calibration&priorZone=n1#set-prior');
		expect(priorZoneFromUrl(new URLSearchParams('priorZone='))).toBeNull();
	});

	it('opens the panel’s For on a ticked zone only, and asks the route for the same target the panel showed', () => {
		const zones = [{ nodeId: 'n1' }, { nodeId: 'n2' }];
		expect(panelZoneFor('n2', zones)).toBe('n2');
		expect(panelZoneFor('outlet', zones)).toBeNull();
		expect(panelZoneFor('gone', zones)).toBeNull();
		expect(panelZoneFor(null, zones)).toBeNull();
		expect(routeZoneOf('n2', true)).toBe('n2');
		expect(routeZoneOf(null, true)).toBe('outlet');
		expect(routeZoneOf(null, false)).toBeNull();
		for (const z of ['n1', null]) expect(panelZoneFor(priorZoneFromUrl(query(priorDonorsMapHref(routeZoneOf(z, true)))), zones)).toBe(z);
	});
});
