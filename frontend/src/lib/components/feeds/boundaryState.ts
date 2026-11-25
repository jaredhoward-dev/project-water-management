// Whether a CHIRPS feed reads the map's catchment boundary (issue #326
// B-rain). No imports: the Map tab's link (map/MapRainLink.svelte) uses it,
// and stays out of the feeds panel's chunk. Re-exported from ./feeds.ts.

/** The part of a feed this needs: its source and the boundary its cells came from, if any (backend feeds/config.ts BoundaryMark). */
interface FeedLike {
	source: string;
	config: { boundary?: { featureId: string; updatedAt: string; geomHash?: string } };
}

/** The boundary on the map now: its id, version and outline hash (absent from an older server). */
interface BoundaryNow {
	id: string;
	updatedAt: string;
	geomHash?: string | null;
}

/**
 * Whether a mark still reads the boundary as it is now (backend feeds/config.ts boundaryMarkCurrent): with the
 * outline's hash on both sides (followups F7), the same outline, so a rename or a relink isn't a change and a reshape
 * to the same area is; a mark from before the hash, the same version (updatedAt).
 */
function current(m: { updatedAt: string; geomHash?: string }, boundary: BoundaryNow): boolean {
	if (m.geomHash && boundary.geomHash) return m.geomHash === boundary.geomHash;
	return Date.parse(m.updatedAt) === Date.parse(boundary.updatedAt);
}

/**
 * 'current' when a CHIRPS feed reads the boundary as it is, 'changed' when one read an earlier outline (the boundary
 * was redrawn since), 'none' otherwise. The Map tab offers to set the rain feed up unless it is 'current'.
 */
export function boundaryFeedState(feeds: readonly FeedLike[], boundary: BoundaryNow): 'current' | 'changed' | 'none' {
	const marks = feeds.filter((f) => f.source === 'chirps' && f.config.boundary?.featureId === boundary.id).map((f) => f.config.boundary!);
	if (marks.some((m) => current(m, boundary))) return 'current';
	return marks.length ? 'changed' : 'none';
}
