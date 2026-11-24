// The disposable-domain check (disposable.ts) over the vendored list (disposableDomains.ts).
import { describe, expect, it } from 'vitest';
import { disposableDomainCount, emailDomain, isDisposable, isDisposableDomain } from './disposable.js';
import { DISPOSABLE_DOMAINS_TEXT } from './disposableDomains.js';

describe('emailDomain', () => {
	it('takes what follows the last @, lower-cased, a trailing dot dropped', () => {
		expect(emailDomain('Someone@Example.COM')).toBe('example.com');
		expect(emailDomain('"a@b"@example.org.')).toBe('example.org');
	});
	it('is null with no domain', () => {
		expect(emailDomain('nobody')).toBeNull();
		expect(emailDomain('nobody@')).toBeNull();
	});
});

describe('isDisposable', () => {
	it('refuses a listed domain, whatever its case', () => {
		expect(isDisposable('x@mailinator.com')).toBe(true);
		expect(isDisposable('x@MAILINATOR.com')).toBe(true);
		expect(isDisposable('x@mailinator.com.')).toBe(true);
	});
	it('refuses a subdomain of a listed domain (its parent is on the list)', () => {
		expect(isDisposable('x@inbox.mailinator.com')).toBe(true);
		expect(isDisposableDomain('a.b.mailinator.com')).toBe(true);
	});
	it('passes ordinary providers and the test domains (positive controls)', () => {
		for (const e of ['x@gmail.com', 'x@outlook.com', 'x@example.com', 'x@example.org', 'x@co.za', 'x@farm.co.za']) {
			expect(isDisposable(e), e).toBe(false);
		}
	});
	it('never matches a bare suffix on a parent walk', () => {
		expect(isDisposableDomain('com')).toBe(false);
		expect(isDisposableDomain('mailinator')).toBe(false);
	});
	it('passes an address with no domain (nothing to judge)', () => {
		expect(isDisposable('nobody')).toBe(false);
	});
});

describe('the vendored list', () => {
	it('is one lower-case domain a line, with no duplicates', () => {
		const lines = DISPOSABLE_DOMAINS_TEXT.split('\n').filter((l) => l !== '');
		for (const l of lines) expect(l, l).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
		expect(new Set(lines).size).toBe(lines.length);
	});
	it('holds about the size it was vendored at (a refresh that loses or doubles it is a mistake)', () => {
		// 10 455 at commit 9cf2bee (2026-11-21); a refresh moves this range with the header.
		expect(disposableDomainCount()).toBeGreaterThan(8_000);
		expect(disposableDomainCount()).toBeLessThan(15_000);
	});
	it('lists none of the big mail providers', () => {
		for (const d of ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'mweb.co.za', 'telkomsa.net']) {
			expect(isDisposableDomain(d), d).toBe(false);
		}
	});
});
