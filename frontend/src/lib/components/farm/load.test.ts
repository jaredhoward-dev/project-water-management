import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '#lib/api/client.js';
import { cardOnFailure, classify, farmHref, farmReturn, farmReturnPage, pickNode, savedForPublication, wordsHref, worstFirst } from './load';

/** An error the API wrote itself (its JSON error shape), as the client builds it. */
const api = (status: number) => new ApiError(status, 'x', undefined, null, {}, true);

describe('what a failed request means', () => {
	it('the API’s own 403 and 404 mean access removed; 0 means no signal; the rest a failure', () => {
		expect(classify(api(403))).toBe('removed');
		expect(classify(api(404))).toBe('removed');
		// A WUA viewer's preview withheld while a cap or full-allocation run is published: its own state, by its code (#523 I).
		expect(classify(new ApiError(403, 'x', undefined, 'farm_preview_withheld'))).toBe('withheld');
		expect(classify(new ApiError(404, 'x', undefined, 'farm_preview_withheld'))).toBe('removed');
		expect(classify(new ApiError(403, 'x', undefined, 'note_audience_denied'))).toBe('removed');
		expect(classify(new ApiError(0, 'x'))).toBe('offline');
		expect(classify(api(500))).toBe('failed');
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

describe('the words page names its back link for the page it returns to', () => {
	it('says which farm page a return address is', () => {
		expect(farmReturnPage('/farm/p1')).toBe('farm');
		expect(farmReturnPage('/farm/p1?node=n-2')).toBe('farm');
		expect(farmReturnPage('/farm/p1/dam?node=n_2')).toBe('dam');
		expect(farmReturnPage('/farm/p1/why')).toBe('why');
		expect(farmReturnPage('/farm/p1/who-decides?node=n')).toBe('who-decides');
	});
	it('names the account pages that link to a farmer word', () => {
		expect(farmReturnPage('/account')).toBe('account');
		expect(farmReturnPage('/account/alerts')).toBe('alerts');
		expect(farmReturnPage('/account/invitations')).toBe('invitations');
	});
	it('is null for anything farmReturn refuses', () => {
		for (const bad of [null, '', '/farm/words', '/farm/p1/settings', '//evil.example/farm/p1/dam']) expect(farmReturnPage(bad)).toBeNull();
	});
});

describe('the words page returns to the farm page it was opened from', () => {
	it('takes a farm page, its sub-pages and ?node=', () => {
		for (const ok of ['/farm/p1', '/farm/p1?node=n-2', '/farm/p1/why', '/farm/p1/dam?node=n_2', '/farm/p1/who-decides'])
			expect(farmReturn(ok)).toBe(ok);
	});
	it('takes the account pages that link to a farmer word, exactly', () => {
		for (const ok of ['/account', '/account/alerts', '/account/invitations']) expect(farmReturn(ok)).toBe(ok);
		for (const bad of ['/account/', '/account/plan', '/account/alerts?x=1', '/account/alerts/../../projects', '/accounts', '//account/alerts', '/account/alerts#x'])
			expect(farmReturn(bad)).toBeNull();
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
	it('adds nothing from a page that is neither a farm page nor an account page that links a word', () => {
		expect(wordsHref('', { pathname: '/projects/p1', search: '' })).toBe('/farm/words');
		expect(wordsHref('', { pathname: '/account/plan', search: '' })).toBe('/farm/words');
	});
	it('carries the alert settings, so the words page leads back to them, not to the list of units', () => {
		expect(wordsHref('', { pathname: '/account/alerts', search: '' }, 'farm-alerts')).toBe(`/farm/words?from=${encodeURIComponent('/account/alerts')}#farm-alerts`);
		expect(wordsHref('/app', { pathname: '/app/account', search: '' })).toBe(`/app/farm/words?from=${encodeURIComponent('/account')}`);
	});
	it('on the words page, passes on its own from, never a bad one', () => {
		expect(wordsHref('', { pathname: '/farm/words', search: '?from=%2Ffarm%2Fp1' })).toBe(`/farm/words?from=${encodeURIComponent('/farm/p1')}`);
		expect(wordsHref('', { pathname: '/farm/words', search: '?from=%2F%2Fevil.example' })).toBe('/farm/words');
		expect(wordsHref('', { pathname: '/projects', search: '' }, 'farm-modelled')).toBe('/farm/words#farm-modelled');
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

describe('classify: a 403 or 404 the API didn’t write', () => {
	it('is a failure, not a removed farm: a WAF block page or a CloudFront error says nothing about access', () => {
		expect(classify(new ApiError(403, 'Forbidden'))).toBe('failed');
		expect(classify(new ApiError(404, 'Not Found'))).toBe('failed');
		// Positive control: the same statuses from the API are removed.
		expect(classify(api(403))).toBe('removed');
		expect(classify(new ApiError(404, 'not found', undefined, null, {}, true))).toBe('removed');
	});
	it('reads it from what the client builds from a real answer: an HTML 403 vs the API’s JSON 403', async () => {
		const answer = (body: string, type: string) => async () => new Response(body, { status: 403, headers: { 'Content-Type': type } });
		const waf = await createApi('', answer('<html><body>Request blocked</body></html>', 'text/html') as typeof fetch).farm.index('p1').catch((e: unknown) => e);
		expect(waf).toBeInstanceOf(ApiError);
		expect((waf as ApiError).fromApi).toBe(false);
		expect(classify(waf)).toBe('failed');
		const own = await createApi('', answer('{"error":"forbidden"}', 'application/json') as typeof fetch).farm.index('p1').catch((e: unknown) => e);
		expect((own as ApiError).fromApi).toBe(true);
		expect(classify(own)).toBe('removed');
	});
});

describe('cardOnFailure (/farm: a card whose figures fail)', () => {
	const saved = { farm: 'saved copy' };
	it('drops a farm unlinked since the list loaded (403/404) without reading its saved copy', () => {
		for (const status of [403, 404]) {
			let read = false;
			expect(cardOnFailure(api(status), () => ((read = true), saved))).toEqual({ drop: true });
			expect(read).toBe(false);
		}
	});
	it('keeps the card and falls back to its saved copy on a 403 the API didn’t write (a WAF block)', () => {
		expect(cardOnFailure(new ApiError(403, 'Forbidden'), () => saved)).toEqual({ drop: false, withheld: false, view: saved });
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
		expect(cardOnFailure(api(403), () => saved)).toEqual({ drop: true });
		// A 404 carrying the code is still removed (classify reads the code only on a 403).
		expect(cardOnFailure(new ApiError(404, 'x', undefined, 'farm_preview_withheld'), () => saved)).toEqual({ drop: true });
	});
});

describe('cardOnFailure keeps when the saved copy was saved', () => {
	it('hands back the saved entry whole, so the /farm card can say the figures are the phone’s copy from then', () => {
		const entry = { view: { farm: 'saved copy' }, savedAt: 1_700_000_000_000, usedAt: 1_700_000_100_000 };
		const next = cardOnFailure(new ApiError(500, 'x'), () => entry);
		expect(next).toEqual({ drop: false, withheld: false, view: entry });
		expect(next.drop === false && !next.withheld && next.view?.savedAt).toBe(1_700_000_000_000);
	});
});

describe('savedForPublication (/farm: a saved copy from an older publication, #942)', () => {
	const entry = (publishedAt: string) => ({ view: { publication: { publishedAt } }, savedAt: 1, usedAt: 2 });
	it('keeps a copy of the publication the catchment has now', () => {
		const e = entry('2026-11-01T08:00:00Z');
		expect(savedForPublication(e, { publishedAt: '2026-11-01T08:00:00Z' })).toBe(e);
	});
	it('drops a copy of an older (or any other) publication, which describes a superseded decision', () => {
		expect(savedForPublication(entry('2026-10-01T08:00:00Z'), { publishedAt: '2026-11-01T08:00:00Z' })).toBeNull();
	});
	it('shows no copy when the catchment has no publication now, or there is no copy', () => {
		expect(savedForPublication(entry('2026-11-01T08:00:00Z'), null)).toBeNull();
		expect(savedForPublication(null, { publishedAt: '2026-11-01T08:00:00Z' })).toBeNull();
	});
	it('drops a copy whose publication has the same day but a later republish time', () => {
		expect(savedForPublication(entry('2026-11-01T08:00:00Z'), { publishedAt: '2026-11-01T09:30:00Z' })).toBeNull();
	});
});
