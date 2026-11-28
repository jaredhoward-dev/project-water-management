// Unsaved work and the leave guard's question (issue #162 items 11 and 13).
// The guard itself is leaveGuard.ts. One question, in the app's
// own dialog, before a navigation drops unsaved work. Each piece of unsaved
// work registers itself here while its component is mounted (guardUnsaved):
// the workspace's model edits and project details, override mode's edits, a
// half-filled scenario change or rename, and the New scenario dialog. The root
// layout installs the one `beforeNavigate` that asks (installLeaveGuard), so
// several pieces of unsaved work give one question naming them all and where
// the navigation goes ("Leave and go to All projects?").
//
// Closing the tab or reloading can't show an app dialog: the browser asks its
// own "Leave site?" there, and that is the only place it does.
import { onMount } from 'svelte';
import type { ReadonlyURL } from '$app/state';

export interface UnsavedWork {
	/** Whether there is unsaved work now. */
	dirty: () => boolean;
	/** What is unsaved, as the question lists it: "model edits", "project details". */
	what: string | (() => string);
	/**
	 * Whether a navigation from `from` to `to` drops the work. The default:
	 * any change of page (path); a tab change within the workspace keeps the
	 * page's own state, so only its parts that live in one tab say more.
	 */
	leaves?: (from: ReadonlyURL, to: ReadonlyURL, how?: NavigationHow) => boolean;
}

/** How the guard saw a navigation made: `replace` for a replacing goto (guardedGoto with `replace: true`), the app's own tidy-ups. */
export interface NavigationHow {
	replace?: boolean;
}

const registered = new Set<UnsavedWork>();

/** Register unsaved work; the function returned unregisters it. */
export function registerUnsaved(work: UnsavedWork): () => void {
	registered.add(work);
	return () => {
		registered.delete(work);
	};
}

/** Register unsaved work for as long as the calling component is mounted. Call during component init. */
export function guardUnsaved(work: UnsavedWork): void {
	onMount(() => registerUnsaved(work));
}

export const pathChanges = (from: ReadonlyURL, to: ReadonlyURL) => from.pathname !== to.pathname;

/** The registered work a navigation from `from` to `to` would drop (`to` null: the page is unloading). */
export function unsavedDroppedBy(from: ReadonlyURL, to: ReadonlyURL | null, works: Iterable<UnsavedWork> = registered, how: NavigationHow = {}): UnsavedWork[] {
	return [...works].filter((w) => w.dirty() && (!to || (w.leaves ?? pathChanges)(from, to, how)));
}

/**
 * Whether `to` is `from` with only some query parameters removed: the same path and the same tab
 * (`tab=`), every parameter `to` has is in `from` with the same values, and at least one is gone.
 */
export function onlyDropsParams(from: ReadonlyURL, to: ReadonlyURL): boolean {
	if (from.pathname !== to.pathname) return false;
	const a = new URLSearchParams(from.search);
	const b = new URLSearchParams(to.search);
	if (a.get('tab') !== b.get('tab')) return false;
	const keys = new Set(b.keys());
	for (const k of keys) if (a.getAll(k).join('\u0000') !== b.getAll(k).join('\u0000')) return false;
	return [...a.keys()].some((k) => !keys.has(k));
}

/**
 * The `leaves` of a field holding text it can't take (common/invalidFields): it goes with its page, or
 * with a change of the URL's query that swaps what the tab shows, so those ask; a #fragment doesn't.
 * A replacing goto that only drops query parameters on the same page and tab doesn't either: that is
 * the app tidying its URL after the fact (a stale `node=` replaced out, the Data feeds card's `rain=`
 * removed once the card has closed), which keeps the tab and its fields mounted, and asking there
 * raised "Leave without saving?" over nothing the person did, and on Stay left the closed card's
 * `rain=` in the URL. A URL-backed sheet's close still asks: it asks before it shuts (confirmLeave),
 * where no `replace` is given.
 */
export function invalidFieldsLeave(from: ReadonlyURL, to: ReadonlyURL, how: NavigationHow = {}): boolean {
	if (from.pathname !== to.pathname) return true;
	if (from.search === to.search) return false;
	return !(how.replace && onlyDropsParams(from, to));
}

/** Any unsaved work at all (the chunk-failure message, the reload prompt). */
export function anyUnsaved(): boolean {
	return [...registered].some((w) => w.dirty());
}

export const whatOf = (w: UnsavedWork) => (typeof w.what === 'function' ? w.what() : w.what);

/** "a, b and c". */
export function listAnd(items: string[]): string {
	if (items.length <= 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The question's words. `destination` null: somewhere outside the app. */
export function leaveQuestion(whats: string[], destination: string | null): { title: string; message: string } {
	const unique = [...new Set(whats)];
	const where = destination ? `Leave and go to ${destination}?` : 'Leave this page?';
	return {
		title: 'Leave without saving?',
		message: `You have unsaved changes${unique.length ? ` (${listAnd(unique)})` : ''}. ${where} They will be lost.`
	};
}
