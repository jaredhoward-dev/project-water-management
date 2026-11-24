// Disposable email addresses (issue #641 § Free tier and abuse, anti-abuse
// item 5; docs/security.md § Verified email on Free). Answers from the
// vendored CC0 list in disposableDomains.ts, never a network call. An address
// is disposable when its domain, or any parent domain of it, is on the list:
// `x.mailinator.com` is refused with `mailinator.com`. The public suffix
// itself (`com`) is never on the list, so a parent walk can't match one.
//
// Read by the Free tier's verified-email gate (billing/emailGate.ts) and, once
// wired, by sign-up, an email change and the reverse trial.
import { DISPOSABLE_DOMAINS_TEXT } from './disposableDomains.js';

let domains: Set<string> | null = null;
/** The list as a set, built on first use (about 10 000 entries). */
function list(): Set<string> {
	if (!domains) domains = new Set(DISPOSABLE_DOMAINS_TEXT.split('\n').filter((d) => d !== ''));
	return domains;
}

/** The lower-cased domain of an address (after its last `@`, a trailing dot dropped), or null when it has none. */
export function emailDomain(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at < 0) return null;
	const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
	return domain === '' ? null : domain;
}

/** Whether a domain, or one of its parent domains, is on the disposable list. */
export function isDisposableDomain(domain: string): boolean {
	const labels = domain.trim().toLowerCase().replace(/\.$/, '').split('.');
	const set = list();
	for (let i = 0; i < labels.length - 1; i++) {
		if (set.has(labels.slice(i).join('.'))) return true;
	}
	return false;
}

/** Whether an email address's domain (or a parent of it) is disposable. An address with no domain isn't. */
export function isDisposable(email: string): boolean {
	const domain = emailDomain(email);
	return domain !== null && isDisposableDomain(domain);
}

/** How many domains the vendored list holds (for its test's size guard). */
export const disposableDomainCount = (): number => list().size;
