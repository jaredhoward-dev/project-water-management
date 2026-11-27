// The leave guard's beforeNavigate (leaveGuard.ts) on SvelteKit 3: shallow
// routing is a goto({ shallow: true }) now, which reaches beforeNavigate as
// pushState/replaceState never did, and it must not ask about unsaved work it
// doesn't drop (the token pages rewrite their address on load).
//
// Issue #931: a navigation made again after Leave keeps the options it was first made with, and
// a URL-backed sheet's close asks first (confirmLeave), so Stay keeps it open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto, type BeforeNavigate } from '$app/navigation';

const h = vi.hoisted(() => ({ handler: null as null | ((nav: BeforeNavigate) => void), confirm: vi.fn(), url: new URL('https://app.test/projects/p1?tab=network') }));

vi.mock('svelte', async (importOriginal) => ({ ...(await importOriginal<typeof import('svelte')>()), onMount: () => {} }));
vi.mock('$app/navigation', () => ({
	beforeNavigate: (fn: (nav: BeforeNavigate) => void) => {
		h.handler = fn;
	},
	goto: vi.fn(() => new Promise<void>(() => {}))
}));
vi.mock('$app/state', () => ({ page: { get url() { return h.url; } } }));
vi.mock('#lib/nav/base.js', () => ({ basePath: () => '' }));
vi.mock('#lib/components/common/confirm.svelte.js', () => ({ confirmDialog: h.confirm }));

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { confirmLeave, guardedGoto, installLeaveGuard, linkOptions, noteLinkClick, type LinkOptionSource } from './leaveGuard';
import { invalidFieldsLeave, onlyDropsParams, registerUnsaved } from './unsaved';

function nav(to: string, extra: Partial<BeforeNavigate> = {}): BeforeNavigate & { cancel: ReturnType<typeof vi.fn> } {
	return { from: null, to: { url: new URL(to) }, type: 'goto', willUnload: false, shallow: false, cancel: vi.fn(), complete: Promise.resolve(), ...extra } as unknown as BeforeNavigate & { cancel: ReturnType<typeof vi.fn> };
}

describe('the leave guard', () => {
	let unregister: () => void;
	beforeEach(() => {
		h.confirm.mockReset().mockResolvedValue(false);
		installLeaveGuard();
		unregister = registerUnsaved({ dirty: () => true, what: 'model edits' });
	});
	afterEach(() => unregister());

	it('lets a shallow goto through: it rewrites the address, the page and its work stay', () => {
		const n = nav('https://app.test/teams', { shallow: true });
		h.handler!(n);
		expect(n.cancel).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it('positive control: the same navigation, not shallow, is stopped and asks', async () => {
		const n = nav('https://app.test/teams');
		h.handler!(n);
		expect(n.cancel).toHaveBeenCalledOnce();
		// The question waits for destination.ts, which loads only when one is asked (nameOf).
		await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
		expect(h.confirm.mock.calls[0]![0]).toMatchObject({ confirmLabel: 'Leave without saving' });
		// Named through the lazily loaded destination.ts.
		expect(h.confirm.mock.calls[0]![0].message).toContain('Leave and go to Teams?');
	});

	describe('a navigation made again after Leave (issue #931)', () => {
		// An open sheet holding a field that can't take its text: closing it (any change of query) drops it.
		beforeEach(() => {
			unregister();
			unregister = registerUnsaved({ dirty: () => true, what: 'fields that need fixing', leaves: (f, t) => f.search !== t.search });
			h.url = new URL('https://app.test/projects/p1?tab=network&edit=n1');
		});
		afterEach(() => {
			h.url = new URL('https://app.test/projects/p1?tab=network');
		});
		beforeEach(() => {
			vi.mocked(goto).mockClear();
			h.confirm.mockResolvedValue(true);
		});

		it('repeats a guarded goto with its own options, so a replacing close replaces again', async () => {
			void guardedGoto('?tab=network', { replace: true, reset: false });
			const n = nav('https://app.test/projects/p1?tab=network');
			h.handler!(n);
			expect(n.cancel).toHaveBeenCalledOnce();
			await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(2));
			expect(vi.mocked(goto).mock.calls[1]).toEqual([new URL('https://app.test/projects/p1?tab=network'), { replace: true, reset: false }]);
		});

		it('positive control: a goto the guard never saw the options of is repeated with none', async () => {
			const n = nav('https://app.test/projects/p1?tab=dams');
			h.handler!(n);
			await vi.waitFor(() => expect(goto).toHaveBeenCalledOnce());
			expect(vi.mocked(goto).mock.calls[0]).toEqual([new URL('https://app.test/projects/p1?tab=dams'), undefined]);
		});

		it("doesn't lend a guarded goto's options to a link to the same place", async () => {
			void guardedGoto('/projects/p1?tab=crops', { replace: true });
			const n = nav('https://app.test/projects/p1?tab=crops', { type: 'link' } as Partial<BeforeNavigate>);
			h.handler!(n);
			await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(2));
			expect(vi.mocked(goto).mock.calls[1]![1]).toBeUndefined();
		});

		it('lets the repeated navigation through once, unasked', async () => {
			h.handler!(nav('https://app.test/projects/p1?tab=map'));
			await vi.waitFor(() => expect(goto).toHaveBeenCalledOnce());
			const again = nav('https://app.test/projects/p1?tab=map');
			h.handler!(again);
			expect(again.cancel).not.toHaveBeenCalled();
			expect(h.confirm).toHaveBeenCalledOnce();
		});
	});

	describe('a replacing goto that only drops query parameters, with a bad value elsewhere on the tab', () => {
		// The workspace's guard for a number field holding text it can't take (routes/projects/[id]/+page.svelte).
		beforeEach(() => {
			unregister();
			unregister = registerUnsaved({ dirty: () => true, what: 'fields that need fixing', leaves: invalidFieldsLeave });
			vi.mocked(goto).mockClear();
		});
		afterEach(() => {
			h.url = new URL('https://app.test/projects/p1?tab=network');
		});

		it('lets a stale node= replaced out of the URL through, unasked', () => {
			h.url = new URL('https://app.test/projects/p1?tab=network&layer=supply&node=gone');
			void guardedGoto('/projects/p1?tab=network&layer=supply', { replace: true, reset: false });
			const n = nav('https://app.test/projects/p1?tab=network&layer=supply');
			h.handler!(n);
			expect(n.cancel).not.toHaveBeenCalled();
			expect(h.confirm).not.toHaveBeenCalled();
		});

		it('lets the closed Data feeds card drop rain= and feed=, unasked, so rain= never stays behind', () => {
			h.url = new URL('https://app.test/projects/p1?tab=series&series=a&rain=units&feed=dws#data-feeds');
			void guardedGoto('/projects/p1?tab=series&series=a#data-feeds', { replace: true, reset: false });
			const n = nav('https://app.test/projects/p1?tab=series&series=a#data-feeds');
			h.handler!(n);
			expect(n.cancel).not.toHaveBeenCalled();
			expect(h.confirm).not.toHaveBeenCalled();
		});

		it('positive control: a real navigation from the same URL still asks (another tab, a pushed goto, a link, a new parameter)', async () => {
			// Its own URLs: a goto the mocked SvelteKit never finishes keeps its noted options for that href.
			h.url = new URL('https://app.test/projects/p1?tab=network&layer=pos&node=gone');
			const cases: [string, Partial<BeforeNavigate>, boolean][] = [
				['https://app.test/projects/p1?tab=dams&layer=pos', {}, true], // another tab, even replacing
				['https://app.test/projects/p1?tab=network&layer=pos', {}, false], // the same drop, but pushed: a step the person took
				['https://app.test/projects/p1?tab=network&layer=pos', { type: 'link' } as Partial<BeforeNavigate>, false], // a link click
				['https://app.test/projects/p1?tab=network&layer=pos&node=n2', {}, true], // a value changed, not only dropped
				['https://app.test/teams', {}, true] // another page
			];
			for (const [to, extra, replace] of cases) {
				h.confirm.mockClear();
				if (replace) void guardedGoto(to, { replace: true });
				const n = nav(to, extra);
				h.handler!(n);
				expect(n.cancel, to).toHaveBeenCalledOnce();
				await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
			}
		});

		it('still asks before a URL-backed sheet shuts (confirmLeave carries no replace)', async () => {
			h.url = new URL('https://app.test/projects/p1?tab=network&edit=n1&node=n1');
			h.confirm.mockResolvedValue(false);
			expect(await confirmLeave('/projects/p1?tab=network&node=n1')).toBe(false);
			expect(h.confirm).toHaveBeenCalledOnce();
		});
	});

	describe('confirmLeave, asked before a URL-backed sheet shuts (issue #931)', () => {
		// An open sheet holding a field that can't take its text: closing it (any change of query) drops it.
		beforeEach(() => {
			unregister();
			unregister = registerUnsaved({ dirty: () => true, what: 'fields that need fixing', leaves: (f, t) => f.search !== t.search });
			h.url = new URL('https://app.test/projects/p1?tab=network&edit=n1');
		});
		afterEach(() => {
			h.url = new URL('https://app.test/projects/p1?tab=network');
		});
		it('Stay: false, so the sheet stays open, and its close navigation would still be asked about', async () => {
			h.confirm.mockResolvedValue(false);
			expect(await confirmLeave('?tab=network')).toBe(false);
			const n = nav('https://app.test/projects/p1?tab=network');
			h.handler!(n);
			expect(n.cancel).toHaveBeenCalledOnce();
		});

		it('Leave: true, and the close navigation that follows goes through unasked', async () => {
			h.confirm.mockResolvedValue(true);
			expect(await confirmLeave('?tab=network')).toBe(true);
			expect(h.confirm).toHaveBeenCalledOnce();
			const n = nav('https://app.test/projects/p1?tab=network');
			h.handler!(n);
			expect(n.cancel).not.toHaveBeenCalled();
			expect(h.confirm).toHaveBeenCalledOnce();
		});

		it('nothing unsaved dropped: true without asking', async () => {
			unregister();
			unregister = registerUnsaved({ dirty: () => false, what: 'fields that need fixing', leaves: () => true });
			expect(await confirmLeave('?tab=network')).toBe(true);
			expect(h.confirm).not.toHaveBeenCalled();
		});

		it('positive control: the work the close drops is named in the question', async () => {
			expect(await confirmLeave('?tab=network')).toBe(false);
			expect(h.confirm).toHaveBeenCalledOnce();
			expect(h.confirm.mock.calls[0]![0].message).toContain('fields that need fixing');
		});

		it('one question at a time: a second close while it is up keeps the sheet open', async () => {
			let answer!: (ok: boolean) => void;
			h.confirm.mockReturnValue(new Promise<boolean>((r) => (answer = r)));
			const first = confirmLeave('?tab=network');
			expect(await confirmLeave('?tab=network')).toBe(false);
			answer(false);
			expect(await first).toBe(false);
			expect(h.confirm).toHaveBeenCalledOnce();
		});
	});

	describe('a link the guard stopped is followed again as SvelteKit followed it (issue #931)', () => {
		beforeEach(() => {
			unregister();
			unregister = registerUnsaved({ dirty: () => true, what: 'fields that need fixing', leaves: (f, t) => f.search !== t.search });
			vi.mocked(goto).mockClear();
			h.confirm.mockResolvedValue(true);
		});

		/** A link with `attrs`, inside a parent with `parent`. */
		function link(href: string, attrs: Record<string, string> = {}, parent: Record<string, string> = {}) {
			const up: LinkOptionSource = { getAttribute: (n) => parent[n] ?? null, parentElement: null };
			const a = { href, getAttribute: (n: string) => attrs[n] ?? null, parentElement: up };
			return { ...a, closest: (sel: string) => (sel === 'a[href]' ? a : null) };
		}

		it('reads replacestate and reset from the link or the nearest element above it', () => {
			expect(linkOptions(link('/x'))).toEqual({});
			expect(linkOptions(link('/x', { 'data-sveltekit-replacestate': '' }))).toEqual({ replace: true });
			expect(linkOptions(link('/x', {}, { 'data-sveltekit-replacestate': 'true', 'data-sveltekit-reset': 'false' }))).toEqual({ replace: true, reset: false });
			// The nearest wins: the link's own 'false' over its parent's on.
			expect(linkOptions(link('/x', { 'data-sveltekit-replacestate': 'false' }, { 'data-sveltekit-replacestate': '' }))).toEqual({});
			// SvelteKit 3 ignores the old noscroll and keepfocus, so the repeat does too.
			expect(linkOptions(link('/x', { ['data-sveltekit-' + 'noscroll']: '' }))).toEqual({});
			expect(linkOptions(link('/x', {}, { 'data-sveltekit-reset': '' }))).toEqual({});
		});

		it('a replacing link, stopped and then agreed to, is repeated replacing', async () => {
			noteLinkClick({ target: link('https://app.test/projects/p1?tab=outputs', { 'data-sveltekit-replacestate': '', 'data-sveltekit-reset': 'false' }) as unknown as EventTarget });
			h.handler!(nav('https://app.test/projects/p1?tab=outputs', { type: 'link' } as Partial<BeforeNavigate>));
			await vi.waitFor(() => expect(goto).toHaveBeenCalledOnce());
			expect(vi.mocked(goto).mock.calls[0]).toEqual([new URL('https://app.test/projects/p1?tab=outputs'), { replace: true, reset: false }]);
		});

		it('positive control: a click on another link lends nothing to this navigation', async () => {
			noteLinkClick({ target: link('https://app.test/projects/p1?tab=dams', { 'data-sveltekit-replacestate': '' }) as unknown as EventTarget });
			h.handler!(nav('https://app.test/projects/p1?tab=river', { type: 'link' } as Partial<BeforeNavigate>));
			await vi.waitFor(() => expect(goto).toHaveBeenCalledOnce());
			expect(vi.mocked(goto).mock.calls[0]![1]).toBeUndefined();
		});

		it('guardedGoto hands goto the options exactly as given: none stays none', () => {
			void guardedGoto('/teams');
			expect(vi.mocked(goto).mock.calls[0]).toEqual(['/teams']);
			void guardedGoto('/teams', { replace: true });
			expect(vi.mocked(goto).mock.calls[1]).toEqual(['/teams', { replace: true }]);
		});
	});
});

// Every navigation goes through guardedGoto, so a Leave can repeat it with its options: no
// module but the guard itself imports SvelteKit's goto.
describe('no raw goto outside the guard (issue #931)', () => {
	const SRC = join(__dirname, '..', '..');
	// /share is public and stays off the workspace's code (i18n/boundary.test.ts); it never installs the guard and has no unsaved work.
	const ALLOWED = new Set(['lib/nav/leaveGuard.ts', 'routes/share/+page.svelte']);
	const RAW = /import\s*\{[^}]*\bgoto\b[^}]*\}\s*from\s*['"]\$app\/navigation['"]/;

	function* sources(dir: string): Generator<string> {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) yield* sources(p);
			else if (/\.(svelte|ts|js)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) yield p;
		}
	}

	it('the pattern catches a raw import (positive control)', () => {
		expect(RAW.test("import { afterNavigate, goto } from '$app/navigation';")).toBe(true);
		expect(RAW.test("import { afterNavigate } from '$app/navigation';")).toBe(false);
	});

	it('only the allowlist imports goto from $app/navigation', () => {
		const files = [...sources(SRC)].map((p) => relative(SRC, p).split('\\').join('/'));
		expect(files).toContain('lib/nav/leaveGuard.ts');
		const raw = files.filter((f) => !ALLOWED.has(f) && RAW.test(readFileSync(join(SRC, f), 'utf8')));
		expect(raw).toEqual([]);
	});
});

// SvelteKit 3 replaced the noscroll and keepfocus link options with data-sveltekit-reset="false"
// and ignores the old names (a dev warning only), so a link carrying one resets the scroll and
// focus it meant to keep (issue #931).
describe('no SvelteKit 2 link options left in src', () => {
	const SRC = join(__dirname, '..', '..');
	const OLD = new RegExp(`data-sveltekit-(?:${['noscroll', 'keepfocus'].join('|')})\\b`);

	function* sources(dir: string): Generator<string> {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) yield* sources(p);
			else if (/\.(svelte|ts|js|html)$/.test(e.name)) yield p;
		}
	}

	it('the pattern catches an old name (positive control)', () => {
		expect(OLD.test('<a href="?x" data-sveltekit-' + 'noscroll>')).toBe(true);
		expect(OLD.test('<a href="?x" data-sveltekit-reset="false">')).toBe(false);
	});

	it('no source file uses the old noscroll or keepfocus link option', () => {
		const old = [...sources(SRC)].filter((p) => OLD.test(readFileSync(p, 'utf8'))).map((p) => relative(SRC, p));
		expect(old).toEqual([]);
	});
});

describe('onlyDropsParams and invalidFieldsLeave', () => {
	const u = (s: string) => new URL(s, 'https://app.test');
	it('is true only for the same page and tab with parameters removed and none changed or added', () => {
		expect(onlyDropsParams(u('/projects/p1?tab=series&rain=units&series=a'), u('/projects/p1?tab=series&series=a'))).toBe(true);
		expect(onlyDropsParams(u('/projects/p1?tab=series&rain=units'), u('/projects/p1?tab=series&rain=units'))).toBe(false);
		expect(onlyDropsParams(u('/projects/p1?tab=series&rain=units'), u('/projects/p1?tab=network'))).toBe(false);
		expect(onlyDropsParams(u('/projects/p1?tab=series&rain=units'), u('/projects/p1?rain=units'))).toBe(false);
		expect(onlyDropsParams(u('/projects/p1?tab=series&series=a&rain=units'), u('/projects/p1?tab=series&series=b'))).toBe(false);
		expect(onlyDropsParams(u('/projects/p1?tab=series&rain=units'), u('/projects/p2?tab=series'))).toBe(false);
	});
	it('lets only a replacing drop through; any other query change or a page change leaves', () => {
		const from = u('/projects/p1?tab=network&node=gone');
		expect(invalidFieldsLeave(from, u('/projects/p1?tab=network'), { replace: true })).toBe(false);
		expect(invalidFieldsLeave(from, u('/projects/p1?tab=network'))).toBe(true);
		expect(invalidFieldsLeave(from, u('/projects/p1?tab=crops'), { replace: true })).toBe(true);
		expect(invalidFieldsLeave(from, u('/teams'), { replace: true })).toBe(true);
		expect(invalidFieldsLeave(from, u('/projects/p1?tab=network&node=gone#x'))).toBe(false);
	});
});
