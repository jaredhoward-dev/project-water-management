// The Network and Data tabs' URL rule (issue #933, docs/ui.md § Network):
//
// - a pick (a node on the map or in its list, a series to chart) is a history step, as everywhere
//   (ui-playbook.md § 2, issue #521);
// - closing a panel removes its parameter, and a pick drops the parameters it makes meaningless;
// - a link inside the tab is built from the current URL, so it keeps every other parameter.
//
// Pure functions over a URL, so the rule is tested without a page (tabUrl.test.ts).

type ReadonlyURL = Pick<URL, 'pathname' | 'search' | 'hash'>;

/**
 * The current URL with some parameters set and others removed (`null`): every other parameter
 * and the fragment kept. Returns the path too, so an empty query leaves no bare `?`.
 */
export function hrefWith(url: ReadonlyURL, changes: Record<string, string | null>): string {
	const q = new URLSearchParams(url.search);
	for (const [name, value] of Object.entries(changes)) {
		if (value === null) q.delete(name);
		else q.set(name, value);
	}
	const s = q.toString();
	return `${url.pathname}${s ? `?${s}` : ''}${url.hash}`;
}

/**
 * Charting another series on the Data tab: `series=` set, and what only made sense before the pick dropped:
 * `view=` (a flagged period of the series a Warnings link named) and the Data feeds card's arrival
 * parameters `rain=` and `feed=`, so the Flagged band doesn't come back and a shared link doesn't
 * reopen a proposal.
 */
export function seriesPickHref(url: ReadonlyURL, id: string): string {
	return hrefWith(url, { series: id, view: null, rain: null, feed: null });
}

/** The Data feeds card closed: its arrival parameters go, so a reload doesn't reopen the proposal. */
export function feedCardClosedHref(url: ReadonlyURL): string {
	return hrefWith(url, { rain: null, feed: null });
}

/**
 * A node's form in the sheet over the map, from a link inside the Network tab (the node table's
 * "set by month" cell): `edit=` and `node=` set (the node edited is the one picked), the section it
 * opens on, every other parameter kept but the grid modal's `grid=`, since the sheet opens over the map
 * in its place (Back returns to the grid). No section drops a stale one. The sheet lives on the Network
 * tab, so `tab=network` is set and a farm drawer's `farm=` goes: the unit grid also opens over Crops &
 * demand and Overview (`?tab=crops&grid=nodes`), where keeping the tab landed on Crops with no form.
 */
export function nodeSheetHref(url: ReadonlyURL, id: string, section: string | null = null): string {
	return hrefWith(url, { tab: 'network', edit: id, node: id, section, grid: null, farm: null });
}

/** The farm drawer in place of the node sheet: `edit=` and the sheet's `section=` go, `farm=` comes. */
export function farmDrawerHref(url: ReadonlyURL, id: string): string {
	return hrefWith(url, { edit: null, section: null, farm: id });
}

/**
 * Where the rest of a Demands grid row is set, from the current URL: a unit's crops in its farm drawer on
 * Crops & demand (`tab=crops&farm=`), anything else in its node's sheet on the Network, on its demand
 * section (`tab=network&edit=&node=&section=demand`). The grid (`grid=`) gives way, and the other tab's
 * panel parameters go, so the link opens one thing.
 */
export function demandEditHref(url: ReadonlyURL, kind: string, nodeId: string): string {
	return kind === 'crops'
		? hrefWith(url, { tab: 'crops', farm: nodeId, grid: null, edit: null, section: null })
		: hrefWith(url, { tab: 'network', edit: nodeId, node: nodeId, section: 'demand', grid: null, farm: null });
}
