// The email catalogue's one entry point (WP-2.5; docs/ui.md § Language).
// Usage:
//
//   const tr = mailT(user.locale);          // a language code, or null (→ en)
//   tr.t('mail.verify.heading');            // a string, in tr.lang
//   tr.t('mail.verify.body', { email });    // {email} filled in
//   tr.lang;                                // what to put in <html lang>
//
// An email is in one language from its first word to its last: the person's,
// when that language's email catalogue has every key en.ts has
// (isMailComplete), else English throughout, words, plural rules and dates
// alike. A language one string short never sends a mostly-translated email
// marked lang="en" (read aloud with English pronunciation, WCAG 3.1.1), nor
// one marked as that language with English inside it. `pnpm check:i18n`
// fails while an offered language's email catalogue is incomplete
// (scripts/guards/i18n_sheet.mjs missingMail), so this English only reaches
// a language still marked `translating: true`. Values are filled in raw; the
// template escapes the finished string for the HTML part. The languages are
// the engine's one table; each one's catalogue is a line in ./catalogues.ts.
import { DEFAULT_LOCALE, isLocale, language, type Locale } from '@water-management/engine/languages';
import { CATALOGUES } from './catalogues.js';
import { en, type MailKey, type MailPluralBase } from './en.js';

export type { MailKey, MailPluralBase } from './en.js';

/** Languages a person or an invite can have (app_user.locale, invite.locale: the `language` table, synced from this list). */
export { LOCALES, type Locale } from '@water-management/engine/languages';

/** A stored locale (possibly NULL or unknown) as one we can send. */
export function mailLocale(value: string | null | undefined): Locale {
	return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** `{name}` → vars.name. An unknown placeholder is left as written, so a typo shows rather than vanishing. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

const rules = new Map<Locale, Intl.PluralRules>();
const pluralRules = (lang: Locale) => {
	let r = rules.get(lang);
	if (!r) rules.set(lang, (r = new Intl.PluralRules(language(lang).intl)));
	return r;
};

/**
 * Every key of English's catalogue has words in `cat`. The same rule as
 * check:i18n's missingMail (scripts/guards/i18n_sheet.mjs): a counted
 * message needs each form English has, so the language's own plural rules
 * never reach a form it lacks.
 */
export function isMailComplete(cat: Partial<Record<MailKey, string>>): boolean {
	return (Object.keys(en) as MailKey[]).every((k) => cat[k] != null);
}

/**
 * The language an email to someone with this stored locale is written in:
 * theirs when its email catalogue is complete, else English. Everything an
 * email formats by language (dates, plural rules) goes by this, not by the
 * stored locale.
 */
export function mailLanguage(value: string | null | undefined): Locale {
	const want = mailLocale(value);
	return want === DEFAULT_LOCALE || isMailComplete(CATALOGUES[want] ?? {}) ? want : DEFAULT_LOCALE;
}

export interface MailTranslator {
	t(key: MailKey, vars?: Record<string, string | number>): string;
	/**
	 * A counted message: the form `<base>.<category>` for `n` by the
	 * language's plural rules (Intl.PluralRules in the language table's
	 * locale), `{n}` and `vars` filled in.
	 */
	tn(base: MailPluralBase, n: number, vars?: Record<string, string | number>): string;
	/** The language every word of the email is in (mailLanguage): what goes in <html lang>. */
	readonly lang: Locale;
}

export function mailT(locale: string | null | undefined): MailTranslator {
	const lang = mailLanguage(locale);
	// Complete (or English), so every lookup below finds its words; the
	// English after `??` only satisfies the types.
	const words: Partial<Record<MailKey, string>> = lang === DEFAULT_LOCALE ? en : (CATALOGUES[lang] ?? en);
	const form = (base: MailPluralBase, n: number) => {
		const cat = pluralRules(lang).select(n);
		const exact = words[`${base}.${cat}` as MailKey];
		// English lacks the category (a language with `few`, say): its `other`.
		return exact ?? words[`${base}.other` as MailKey];
	};
	return {
		t(key, vars) {
			return fill(words[key] ?? en[key], vars);
		},
		tn(base, n, vars = {}) {
			return fill(form(base, n) ?? en[`${base}.other` as MailKey], { n, ...vars });
		},
		lang
	};
}
