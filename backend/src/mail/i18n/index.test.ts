import { describe, expect, it, vi } from 'vitest';

// A made-up "Afrikaans" catalogue that marks where each word came from: test
// data only, never wording that ships. Complete (every English key), with a
// few counted forms marked by category; a test drops a key to make it
// incomplete and puts it back.
vi.mock('./af.js', async () => {
	const { en } = await vi.importActual<typeof import('./en.js')>('./en.js');
	const af: Record<string, string> = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `[af] ${v}`]));
	Object.assign(af, {
		'mail.verify.heading': '[af] heading',
		'mail.verify.body': '[af] {email} / {product}',
		'mail.alert.jobs.body.one': '[af one] {count}',
		'mail.alert.jobs.body.other': '[af other] {count}'
	});
	return { af };
});

const { af } = await import('./af.js');
const { en } = await import('./en.js');
const { fill, isMailComplete, mailLanguage, mailLocale, mailT } = await import('./index.js');
const { resetWhen } = await import('../templates.js');

/** Run `fn` with `key` missing from the mocked Afrikaans catalogue. */
function without<T>(key: keyof typeof en, fn: () => T): T {
	const cat = af as Record<string, string | undefined>;
	const kept = cat[key];
	delete cat[key];
	try {
		return fn();
	} finally {
		cat[key] = kept;
	}
}

describe('mailT', () => {
	it('fills placeholders and leaves an unknown one showing', () => {
		expect(mailT('en').t('mail.verify.body', { email: 'a@b.c', product: 'P' })).toBe('Please confirm that a@b.c is your email address for P.');
		expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}');
	});

	it('uses Afrikaans where it has a translation and says so in lang', () => {
		const tr = mailT('af');
		expect(tr.t('mail.verify.heading')).toBe('[af] heading');
		expect(tr.t('mail.verify.body', { email: 'a@b.c', product: 'P' })).toBe('[af] a@b.c / P');
		expect(tr.lang).toBe('af');
	});

	it('writes the whole email in English, lang en, when the language lacks even one key', () => {
		without('mail.verify.action', () => {
			expect(mailLanguage('af')).toBe('en');
			const tr = mailT('af');
			expect(tr.lang).toBe('en');
			// Not just the missing key: every word, so nothing Afrikaans sits in an email marked English.
			expect(tr.t('mail.verify.heading')).toBe('Confirm your email address');
			expect(tr.t('mail.verify.action')).toBe('Confirm email address');
			expect(tr.tn('mail.alert.jobs.body', 1, { count: 1 })).toMatch(/^1 background job failed /);
			// Dates follow the words, not the stored locale.
			expect(resetWhen(new Date('2026-10-03T12:05:00Z'), 'af').date).toBe('3 Oct 2026');
		});
		expect(mailLanguage('af')).toBe('af');
		expect(resetWhen(new Date('2026-10-03T12:05:00Z'), 'af').date).toMatch(/^3 Okt/);
	});

	it('counts a catalogue complete only with every English key', () => {
		expect(isMailComplete(en)).toBe(true);
		expect(isMailComplete(af)).toBe(true);
		const { 'mail.alert.jobs.body.one': _one, ...lessOne } = af;
		expect(isMailComplete(lessOne)).toBe(false);
		expect(isMailComplete({})).toBe(false);
	});

	// Issue #51: "1 days late", "1 background jobs failed".
	it('picks a counted message’s form by the language’s plural rules', () => {
		const en = mailT('en');
		expect(en.tn('mail.alert.jobs.body', 1, { count: 1 })).toMatch(/^1 background job failed /);
		expect(en.tn('mail.alert.jobs.body', 2, { count: 2 })).toMatch(/^2 background jobs failed /);
		expect(en.tn('mail.alert.stale.line', 1, { feed: 'CHIRPS', newest: '2 Jan 2026', overdue: 1 })).toBe('CHIRPS: newest day 2 Jan 2026, 1 day late');
		expect(en.tn('mail.alert.stale.line', 0, { feed: 'CHIRPS', newest: '2 Jan 2026', overdue: 0 })).toBe('CHIRPS: newest day 2 Jan 2026, 0 days late');
		const af = mailT('af');
		expect(af.tn('mail.alert.jobs.body', 1, { count: 1 })).toBe('[af one] 1');
		expect(af.tn('mail.alert.jobs.body', 3, { count: 3 })).toBe('[af other] 3');
		expect(af.lang).toBe('af');
	});

	it('treats an unset or unknown locale as English', () => {
		expect(mailLocale(null)).toBe('en');
		expect(mailLocale('xx')).toBe('en');
		expect(mailLocale('af')).toBe('af');
		expect(mailT(undefined).lang).toBe('en');
	});
});
