// The public pricing page (issue #641 Phase 4), prerendered once per language
// like the landing page (routes/welcome/[[lang=locale]]/+page.ts, issue #137):
// `/welcome/pricing` in English, `/welcome/pricing/<code>` in each other
// language. Its HTML carries that language's words and `<html lang>`
// (hooks.server.ts, LANDING_ROUTES), and the root layout treats it as a
// landing route (no session asked; the address sets the language).
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@water-management/engine/languages';
import { loadCatalogue } from '#lib/i18n/locale.svelte.js';
import type { EntryGenerator, PageLoad } from './$types';

export const ssr = true;
export const prerender = true;

/** Every language but the default (English is `/welcome/pricing` itself, which the crawl finds from the landing page). */
export const entries: EntryGenerator = () => LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((lang) => ({ lang }));

export const load: PageLoad = async ({ params }) => {
	const locale: Locale = params.lang ?? DEFAULT_LOCALE;
	return { locale, catalogue: await loadCatalogue(locale) };
};
