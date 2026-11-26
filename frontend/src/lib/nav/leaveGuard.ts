// The leave guard (issue #162 items 11 and 13): the one `beforeNavigate` that
// asks, in the app's own dialog (confirm.svelte.ts), before a navigation drops
// the unsaved work registered in unsaved.ts, naming where it goes. On Stay the
// navigation is cancelled; on Leave it is made again, let through once.
// Reload and tab close get the browser's own prompt (no page can restyle it).
//
// A navigation made again goes as the first one went (issue #931): `guardedGoto` notes its
// options (`replace`, `reset`, `state`), which beforeNavigate never sees, so a Leave after a
// replacing goto replaces too, and Back doesn't reopen what that goto closed. A URL-backed
// sheet asks before it shuts (`confirmLeave`, the Dialog's `beforeclose`), so Stay keeps it
// open rather than shutting it over a URL that still names it.
import { onMount } from 'svelte';
import { beforeNavigate, goto, type GotoOptions } from '$app/navigation';
import { basePath } from '#lib/nav/base.js';
import { page } from '$app/state';
import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
import { destinationName } from './destination';
import { anyUnsaved, leaveQuestion, unsavedDroppedBy, whatOf } from './unsaved';

// A navigation the person already agreed to: let it through once.
let agreedHref: string | null = null;
let asking = false;
// The options of each guarded goto under way, by the absolute href it goes to.
const gotoOptions = new Map<string, GotoOptions>();

/** Resolve a goto's target as SvelteKit does: against the page's URL. */
const absolute = (url: string | URL) => new URL(url, page.url.href).href;

/** The parts of an element `linkOptions` reads (an Element in the browser). */
export interface LinkOptionSource {
	getAttribute(name: string): string | null;
	readonly parentElement: LinkOptionSource | null;
}

/**
 * The goto options a click on a link has SvelteKit follow it with, read as SvelteKit 3 reads
 * them: the nearest `data-sveltekit-replacestate` and `data-sveltekit-reset` on the link or
 * above it ('' or 'true' on, 'false' off). SvelteKit 3 ignores `data-sveltekit-noscroll` and
 * `-keepfocus` (it only warns of them), so they are not read here either: the repeat goes as
 * the click went.
 */
export function linkOptions(el: LinkOptionSource | null): GotoOptions {
	let replace: string | null = null;
	let reset: string | null = null;
	for (let e = el; e; e = e.parentElement) {
		replace ??= e.getAttribute('data-sveltekit-replacestate');
		reset ??= e.getAttribute('data-sveltekit-reset');
	}
	const on = (v: string | null) => (v === '' || v === 'true' ? true : v === 'false' ? false : undefined);
	const opts: GotoOptions = {};
	if (on(replace)) opts.replace = true;
	if (on(reset) === false) opts.reset = false;
	return opts;
}

// The last link clicked, with the options SvelteKit follows it with: its navigation comes
// through beforeNavigate as type 'link', with no element to read them from.
let lastLink: { href: string; opts: GotoOptions } | null = null;

/** Note a click on a link (the guard's capturing listener; exported for its tests). */
export function noteLinkClick(e: Pick<MouseEvent, 'target'>): void {
	const t = e.target as (Element & { closest?: Element['closest'] }) | null;
	const a = t?.closest?.('a[href]') as HTMLAnchorElement | null | undefined;
	lastLink = a ? { href: new URL(a.href, page.url.href).href, opts: linkOptions(a) } : null;
}

/**
 * `goto`, with its options noted for the guard, so a navigation it stops and the person then
 * agrees to is made again with the same `replace`, `reset` and `state`.
 */
export function guardedGoto(url: string | URL, opts?: GotoOptions): Promise<void> {
	const href = absolute(url);
	const noted = opts ?? {};
	gotoOptions.set(href, noted);
	const forget = () => {
		if (gotoOptions.get(href) === noted) gotoOptions.delete(href);
	};
	// The options go on as given (none stays none), so goto sees exactly what the caller wrote.
	const nav = opts === undefined ? goto(url) : goto(url, opts);
	void Promise.resolve(nav).then(forget, forget);
	return nav;
}

/** Ask the guard's question about `dropped` work, once at a time; resolves to Leave (true) or Stay. */
async function ask(dropped: ReturnType<typeof unsavedDroppedBy>, to: URL | null): Promise<boolean> {
	asking = true;
	try {
		const q = leaveQuestion(dropped.map(whatOf), to ? destinationName(page.url, to, basePath()) : null);
		return await confirmDialog({ ...q, confirmLabel: 'Leave without saving', cancelLabel: 'Stay', danger: true });
	} finally {
		asking = false;
	}
}

/**
 * Before something shuts that a navigation to `to` then follows (a URL-backed sheet's Done,
 * Esc or ✕): true when nothing unsaved is dropped, or the person chose Leave, and that
 * navigation is then let through unasked; false on Stay (keep it open) or while the question
 * is already up.
 */
export async function confirmLeave(to: string | URL): Promise<boolean> {
	const url = new URL(absolute(to));
	const dropped = unsavedDroppedBy(page.url, url);
	if (!dropped.length) return true;
	if (asking) return false;
	const ok = await ask(dropped, url);
	if (ok) agreedHref = url.href;
	return ok;
}

/** Install the guard. Call once, during the root layout's init. */
export function installLeaveGuard(): void {
	// Reload, tab close or an external link: the page unloads, and only the browser's own
	// prompt can show. A plain listener, not SvelteKit's 'leave' navigation, which it skips
	// for an external link it has already let through.
	onMount(() => {
		const onUnload = (e: BeforeUnloadEvent) => {
			if (anyUnsaved()) e.preventDefault();
		};
		addEventListener('beforeunload', onUnload);
		// Capturing, so it runs before SvelteKit's own click handler starts the navigation.
		document.addEventListener('click', noteLinkClick, true);
		return () => {
			removeEventListener('beforeunload', onUnload);
			document.removeEventListener('click', noteLinkClick, true);
		};
	});
	beforeNavigate((nav) => {
		const to = nav.to?.url ?? null;
		if (nav.willUnload) return;
		// A shallow goto (SvelteKit 3's form of pushState/replaceState, which never
		// came through here) only rewrites the address: the page and its work stay.
		if (nav.shallow) return;
		if (to && agreedHref === to.href) {
			agreedHref = null;
			return;
		}
		agreedHref = null;
		const dropped = unsavedDroppedBy(page.url, to);
		if (!dropped.length) return;
		// Read before the cancel settles the goto, which forgets them.
		const opts = !to ? undefined : nav.type === 'goto' ? gotoOptions.get(to.href) : nav.type === 'link' && lastLink?.href === to.href ? lastLink.opts : undefined;
		nav.cancel();
		if (asking) return;
		void ask(dropped, to).then((ok) => {
			if (!ok || !to) return;
			agreedHref = to.href;
			// Back or Forward: the cancelled step was undone, so take it again.
			if (nav.type === 'popstate' && nav.delta) history.go(nav.delta);
			// As it was first made: a replacing goto replaces again (issue #931).
			else void goto(to, opts);
		});
	});
}
