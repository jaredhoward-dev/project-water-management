// The links between the Regional prior panel (Calibration → Fit the parameters,
// `#set-prior`) and the Map tab's Prior donors layer (`layers=donors`; issue
// #622, docs/maps.md § Prior donors). Both carry the prior's target in
// `priorZone=`: a calibration zone's node id, `outlet` for the outlet's own
// zone, absent for the catchment (or the headline location with no zones
// ticked). So the map draws the donors of the zone the panel showed, and its
// link back opens the panel's For on that zone. Light (no engine), since the
// map and the panel both load it.

/** The URL parameter that names the prior's target. */
export const PRIOR_ZONE_PARAM = 'priorZone';

/** The route's `zone` for a target: a node id, `outlet`, or null for the headline. */
export type PriorZone = string | null;

/** The target named in a page's URL (null when absent or empty). */
export function priorZoneFromUrl(params: Pick<URLSearchParams, 'get'>): PriorZone {
	const z = params.get(PRIOR_ZONE_PARAM)?.trim();
	return z ? z : null;
}

const zoneQuery = (zone: PriorZone) => (zone ? `&${PRIOR_ZONE_PARAM}=${encodeURIComponent(zone)}` : '');

/** The panel's link to the Map with the Prior donors layer on, for `zone`. */
export const priorDonorsMapHref = (zone: PriorZone) => `?tab=map&layers=donors${zoneQuery(zone)}`;

/** The map's link back to the Regional prior panel, opening its For on `zone`. */
export const priorPanelHref = (zone: PriorZone) => `?tab=calibration${zoneQuery(zone)}#set-prior`;

/**
 * The panel's For choice for a URL's target, among the ticked zones: a ticked zone's node id; null (the outlet's
 * own zone, or the catchment) for `outlet`, an unknown or unticked node, or none.
 */
export function panelZoneFor(zone: PriorZone, zones: readonly { nodeId: string }[]): string | null {
	return zone && zone !== 'outlet' && zones.some((z) => z.nodeId === zone) ? zone : null;
}

/** The route's `zone` for the panel's For choice: the node, else `outlet` when there are zones, else none. */
export const routeZoneOf = (zone: string | null, hasZones: boolean): PriorZone => zone ?? (hasZones ? 'outlet' : null);
