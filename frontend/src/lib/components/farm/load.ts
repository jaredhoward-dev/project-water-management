// The decisions behind loading a farm page (docs/design/farmer-view.md §6.5,
// §9), apart from the fetching, so they can be tested: which farm to show,
// and what a failed request means for the page.
import type { FarmIndex } from '@water-management/engine';

/** Why a request failed, as the page words it. */
export type Failure = 'removed' | 'withheld' | 'offline' | 'failed';

/**
 * 403 coded `farm_preview_withheld`: a WUA viewer kept from registered volumes
 * previewing a farm while a cap or full-allocation run is published (#523 I);
 * the farm is still in the catchment, so the page says why and keeps the
 * saved copies. Any other 403 or 404 the API wrote itself (a code, or its JSON
 * error shape: ApiError `fromApi`): the farm (or the project) is no longer
 * this user's, so the page says so and the saved copy goes. A 403 or 404 from
 * anything in front of the API (a WAF block page, a CloudFront error) says
 * nothing about access, so it is `failed` and the saved copy stays. Status 0:
 * no signal. Anything else: the server had a problem; the page offers Try
 * again. Never the raw error text.
 */
export function classify(e: unknown): Failure {
	const field = (name: string): unknown => (e && typeof e === 'object' && name in e ? (e as Record<string, unknown>)[name] : null);
	const status = field('status');
	const code = field('code');
	if (status === 403 && code === 'farm_preview_withheld') return 'withheld';
	const fromApi = field('fromApi') === true || (typeof code === 'string' && code !== '');
	if ((status === 403 || status === 404) && fromApi) return 'removed';
	if (status === 0) return 'offline';
	return 'failed';
}

/**
 * A card's figures on /farm when asking for them failed: a farm unlinked (or
 * a project lost) between loading the list and its figures (the API's own
 * 403/404; a WAF block keeps the card and its copy, `classify`) is
 * dropped from the list, as the list's own 403/404 leaves a project out, and
 * its saved copy goes. A preview withheld (403 `farm_preview_withheld`) keeps
 * the card and the phone's saved copy, as the farm page does, but shows no
 * figures: the card says why instead (issue #875), since the saved figures
 * are from before the withholding and would read as current. Any other
 * failure falls back to the phone's saved copy (`saved`, read only then),
 * else nothing.
 */
export type CardFailure<V> = { drop: true } | { drop: false; withheld: true; view: null } | { drop: false; withheld: false; view: V | null };
export function cardOnFailure<V>(e: unknown, saved: () => V | null): CardFailure<V> {
	const why = classify(e);
	if (why === 'removed') return { drop: true };
	if (why === 'withheld') return { drop: false, withheld: true, view: null };
	return { drop: false, withheld: false, view: saved() };
}

/**
 * A saved copy is shown on a /farm card only when it is of the publication the
 * catchment has now (issue #942): a copy from an older one describes a
 * superseded decision (another notice, another restriction level beside the
 * card's current level word), so the card shows none and says its figures
 * couldn't be had instead. Publications are told apart by `publishedAt`, which
 * a republish always moves. No current publication: no copy.
 */
export function savedForPublication<E extends { view: { publication: { publishedAt: string } } }>(saved: E | null, current: { publishedAt: string } | null): E | null {
	return saved && current && saved.view.publication.publishedAt === current.publishedAt ? saved : null;
}

/**
 * The farm to show: the one asked for (?node=) if the index lists it, else
 * the one shown last on this phone, else the first. null when the asked-for
 * farm isn't in the list (it's no longer this user's) or there are none.
 */
export function pickNode(index: Pick<FarmIndex, 'farms'>, asked: string | null, remembered: string | null = null): string | null {
	const ids = index.farms.map((f) => f.nodeId);
	if (asked) return ids.includes(asked) ? asked : null;
	if (remembered && ids.includes(remembered)) return remembered;
	return ids[0] ?? null;
}

/** "/farm/<project>" with ?node= only when the project has several farms (or the page was opened with one). */
export function farmHref(base: string, projectId: string, nodeId: string | null, several: boolean, page = ''): string {
	const q = nodeId && several ? `?node=${encodeURIComponent(nodeId)}` : '';
	return `${base}/farm/${encodeURIComponent(projectId)}${page ? `/${page}` : ''}${q}`;
}

/**
 * A farm page's own address (path and ?node=, without the app's base) that
 * /farm/words may send its back link to: one farm page, its Why?, dam or
 * who-decides page, or one of the three account pages that link to a farmer
 * word (/account, /account/alerts, /account/invitations, exactly), nothing else. Anything else (another site, another app
 * page, a path with dots or slashes doubled) is null, so `?from=` can never
 * be an open redirect.
 */
const FARM_RETURN = /^\/farm\/(?!words(?:[/?]|$))[\w-]+(?:\/(?:why|dam|who-decides))?(?:\?node=[\w-]+)?$/;
const ACCOUNT_RETURN = /^\/account(?:\/(?:alerts|invitations))?$/;
export function farmReturn(raw: string | null | undefined): string | null {
	return raw && (FARM_RETURN.test(raw) || ACCOUNT_RETURN.test(raw)) ? raw : null;
}

/**
 * Which page a `farmReturn` address is: the farm's own page, its dam, Why?
 * or who-decides page, or an account page. The words page names its back link by it,
 * so "back" never says "My hydrological unit" and lands on the dam page.
 */
export type FarmReturnPage = 'farm' | 'dam' | 'why' | 'who-decides' | 'account' | 'alerts' | 'invitations';
export function farmReturnPage(from: string | null): FarmReturnPage | null {
	if (!from || !farmReturn(from)) return null;
	if (ACCOUNT_RETURN.test(from)) return from === '/account/alerts' ? 'alerts' : from === '/account/invitations' ? 'invitations' : 'account';
	const sub = from.split('?')[0]!.split('/')[3];
	return sub === 'dam' || sub === 'why' || sub === 'who-decides' ? sub : 'farm';
}

/**
 * "/farm/words" (with `#anchor`), carrying the farm or account page it is
 * opened from as `?from=`, so its back link returns there rather than to the
 * list of farms. `here` is the current URL; any other page adds nothing, and
 * the words page passes on its own `from`.
 */
export function wordsHref(base: string, here: Pick<URL, 'pathname' | 'search'>, anchor = ''): string {
	const path = base && here.pathname.startsWith(base) ? here.pathname.slice(base.length) : here.pathname;
	// On the words page itself, keep the farm page it came from.
	const from = path === '/farm/words' ? farmReturn(new URLSearchParams(here.search).get('from')) : farmReturn(path + here.search);
	return `${base}/farm/words${from ? `?from=${encodeURIComponent(from)}` : ''}${anchor ? `#${anchor}` : ''}`;
}

/** How much a notice asks of the farmer, worst first: a restriction, an advisory, none, nothing published. */
const SEVERITY: Record<string, number> = { restricted: 0, advisory: 1, none: 2 };

/**
 * The farms list's order (/farm): the worst notice first, so a restriction is
 * never under a screen of unrestricted farms; ties keep the order given.
 */
export function worstFirst<T extends { publication: { restriction: { level: string } } | null }>(rows: readonly T[]): T[] {
	const rank = (r: T) => (r.publication ? (SEVERITY[r.publication.restriction.level] ?? 2) : 3);
	return rows
		.map((r, i) => ({ r, i }))
		.sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
		.map((x) => x.r);
}

/**
 * What /farm does with the farms it could list (`listed`) when some
 * catchment's list failed for a reason other than access going
 * (`incomplete`): nothing listed and a failure is the error state, not "no
 * farm linked"; one farm goes straight to its page only when every catchment
 * answered, since otherwise the farms of the one that failed would be missing
 * with no sign of them; anything else is the list, which says when it is
 * incomplete and offers Try again.
 */
export function farmsLanding(listed: number, incomplete: boolean): 'error' | 'redirect' | 'list' {
	if (!listed && incomplete) return 'error';
	if (listed === 1 && !incomplete) return 'redirect';
	return 'list';
}
