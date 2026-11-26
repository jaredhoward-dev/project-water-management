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

import { confirmLeave, guardedGoto, installLeaveGuard } from './leaveGuard';
import { registerUnsaved } from './unsaved';

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

	it('positive control: the same navigation, not shallow, is stopped and asks', () => {
		const n = nav('https://app.test/teams');
		h.handler!(n);
		expect(n.cancel).toHaveBeenCalledOnce();
		expect(h.confirm).toHaveBeenCalledOnce();
		expect(h.confirm.mock.calls[0]![0]).toMatchObject({ confirmLabel: 'Leave without saving' });
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
});
