import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { cardOnFailure, classify, farmHref, farmReturn, pickNode, wordsHref, worstFirst } from './load';

describe('what a failed request means', () => {
	it('403 and 404 mean access removed; 0 means no signal; the rest a failure', () => {
		expect(classify(new ApiError(403, 'x'))).toBe('removed');
		expect(classify(new ApiError(404, 'x'))).toBe('removed');
		// A WUA viewer's preview withheld while a cap or full-allocation run is published: its own state, by its code (#523 I).
		expect(classify(new ApiError(403, 'x', undefined, 'farm_preview_withheld'))).toBe('withheld');
		expect(classify(new ApiError(404, 'x', undefined, 'farm_preview_withheld'))).toBe('removed');
		expect(classify(new ApiError(403, 'x', undefined, 'note_audience_denied'))).toBe('removed');
		expect(classify(new ApiError(0, 'x'))).toBe('offline');
		expect(classify(new ApiError(500, 'x'))).toBe('failed');
		expect(classify(new ApiError(401, 'x'))).toBe('failed');
		expect(classify(new Error('boom'))).toBe('failed');
		expect(classify(null)).toBe('failed');
	});
});

describe('which farm to show', () => {
	const index = { farms: [{ nodeId: 'a', name: 'A' }, { nodeId: 'b', name: 'B' }] };
	it('takes ?node= only when it is one of the user’s farms', () => {
		expect(pickNode(index, 'b')).toBe('b');
		expect(pickNode(index, 'zzz')).toBeNull();
	});
	it('otherwise the farm shown last on this phone, then the first', () => {
		expect(pickNode(index, null, 'b')).toBe('b');
		expect(pickNode(index, null, 'gone')).toBe('a');
		expect(pickNode(index, null)).toBe('a');
		expect(pickNode({ farms: [] }, null)).toBeNull();
	});
	it('links with ?node= only when there are several farms', () => {
		expect(farmHref('', 'p 1', 'n/1', true, 'why')).toBe('/farm/p%201/why?node=n%2F1');
		expect(farmHref('/base', 'p', 'n', false)).toBe('/base/farm/p');
	});
});

describe('the words page returns to the farm page it was opened from', () => {
	it('takes a farm page, its sub-pages and ?node=', () => {
		for (const ok of ['/farm/p1', '/farm/p1?node=n-2', '/farm/p1/why', '/farm/p1/dam?node=n_2', '/farm/p1/who-decides'])
			expect(farmReturn(ok)).toBe(ok);
	});
	it('refuses anything else, so ?from= is never an open redirect', () => {
		for (const bad of [
			null,
			'',
			'https://evil.example/farm/p1',
			'//evil.example/farm/p1',
			'/farm',
			'/farm/words',
			'/farm/p1/../../projects',
			'/farm/p1/settings',
			'/projects/p1',
			'/farm/p1?node=a&next=//evil',
			'/farm/p1#x',
			'/farm/p1\\evil',
			' /farm/p1'
		])
			expect(farmReturn(bad)).toBeNull();
	});
	it('carries the current farm page, under a base path, with an anchor', () => {
		expect(wordsHref('', { pathname: '/farm/p1/why', search: '?node=n1' }, 'farm-reserve')).toBe(`/farm/words?from=${encodeURIComponent('/farm/p1/why?node=n1')}#farm-reserve`);
		expect(wordsHref('/app', { pathname: '/app/farm/p1', search: '' })).toBe(`/app/farm/words?from=${encodeURIComponent('/farm/p1')}`);
	});
	it('adds nothing from a page that is not a farm page', () => {
		expect(wordsHref('', { pathname: '/account', search: '' })).toBe('/farm/words');
	});
	it('on the words page, passes on its own from, never a bad one', () => {
		expect(wordsHref('', { pathname: '/farm/words', search: '?from=%2Ffarm%2Fp1' })).toBe(`/farm/words?from=${encodeURIComponent('/farm/p1')}`);
		expect(wordsHref('', { pathname: '/farm/words', search: '?from=%2F%2Fevil.example' })).toBe('/farm/words');
		expect(wordsHref('', { pathname: '/account', search: '' }, 'farm-modelled')).toBe('/farm/words#farm-modelled');
	});
});

describe('the farms list puts the worst notice first', () => {
	const row = (id: string, level: string | null) => ({ id, publication: level ? { restriction: { level } } : null });
	it('restricted, advisory, none, then unpublished; ties keep their order', () => {
		const rows = [row('a', null), row('b', 'none'), row('c', 'advisory'), row('d', 'restricted'), row('e', 'advisory'), row('f', 'restricted'), row('g', 'none')];
		expect(worstFirst(rows).map((r) => r.id)).toEqual(['d', 'f', 'c', 'e', 'b', 'g', 'a']);
	});
	it('leaves the input alone', () => {
		const rows = [row('a', null), row('b', 'restricted')];
		worstFirst(rows);
		expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
	});
});

describe('cardOnFailure (/farm: a card whose figures fail)', () => {
	const saved = { farm: 'saved copy' };
	it('drops a farm unlinked since the list loaded (403/404) without reading its saved copy', () => {
		for (const status of [403, 404]) {
			let read = false;
			expect(cardOnFailure(new ApiError(status, 'x'), () => ((read = true), saved))).toEqual({ drop: true });
			expect(read).toBe(false);
		}
	});
	it('falls back to the saved copy on no signal or a server failure, else nothing', () => {
		expect(cardOnFailure(new ApiError(0, 'x'), () => saved)).toEqual({ drop: false, withheld: false, view: saved });
		expect(cardOnFailure(new ApiError(500, 'x'), () => saved)).toEqual({ drop: false, withheld: false, view: saved });
		expect(cardOnFailure(new ApiError(500, 'x'), () => null)).toEqual({ drop: false, withheld: false, view: null });
	});
	it('keeps a withheld preview’s card but shows no saved figures as current (#875)', () => {
		let read = false;
		const next = cardOnFailure(new ApiError(403, 'x', undefined, 'farm_preview_withheld'), () => ((read = true), saved));
		expect(next).toEqual({ drop: false, withheld: true, view: null });
		expect(read).toBe(false);
		// Positive control: the same status without the code is still a removed farm, dropped.
		expect(cardOnFailure(new ApiError(403, 'x'), () => saved)).toEqual({ drop: true });
		// A 404 carrying the code is still removed (classify reads the code only on a 403).
		expect(cardOnFailure(new ApiError(404, 'x', undefined, 'farm_preview_withheld'), () => saved)).toEqual({ drop: true });
	});
});
