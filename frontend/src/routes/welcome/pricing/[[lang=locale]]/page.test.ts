// The pricing page once per language (issue #641 Phase 4): the route's entries
// and load, and the page rendered as the prerender renders it (Svelte's
// server renderer), in English at /welcome/pricing and in Afrikaans at
// /welcome/pricing/af. Every price on it is the plan figures'
// (@water-management/engine/plans, pinned to the `plan` table by
// backend/src/billing/planFigures.db.test.ts). The built HTML, its
// <html lang>, axe and the phone width are e2e/tests/pricing.spec.ts's.
import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from '@water-management/engine/languages';
import { PLAN_FIGURES, planFigures } from '@water-management/engine/plans';
import { messageId } from '#lib/i18n/msg.js';
import { af } from '#lib/i18n/messages/af.js';
import { setLocale } from '#lib/i18n/locale.svelte.js';
import { rand } from '#lib/components/pricing/pricing.js';
import { entries, load, prerender, ssr } from './+page';
import Page from './+page.svelte';

const url = vi.hoisted(() => ({ href: 'https://example.org/welcome/pricing' }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p.replace(/^\//, '')}`, asset: (f: string) => `/${f}` }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL(url.href);
		}
	}
}));
vi.mock('#lib/api/index.js', () => ({ api: {} }));

const HEADING = 'Plans and prices';
type LoadEvent = Parameters<typeof load>[0];
const loadFor = async (lang?: string) => (await load({ params: { lang } } as unknown as LoadEvent)) as { locale: 'en' | 'af'; catalogue: Record<string, unknown> };
const renderAt = async (href: string, lang?: string) => {
	url.href = href;
	return render(Page, { props: { data: await loadFor(lang) } as never });
};
/**
 * The page's text: a scan that drops comments and tags (a quoted attribute value may hold a '>'),
 * each tag read as a space, then the no-break spaces as spaces and runs of space as one.
 */
const text = (html: string) => {
	let out = '';
	let i = 0;
	while (i < html.length) {
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end === -1 ? html.length : end + 3;
		} else if (html[i] === '<') {
			let quote = '';
			i++;
			while (i < html.length && (quote || html[i] !== '>')) {
				if (quote) {
					if (html[i] === quote) quote = '';
				} else if (html[i] === '"' || html[i] === "'") quote = html[i]!;
				i++;
			}
			i++;
			out += ' ';
		} else out += html[i++];
	}
	return out.replace(/\u00a0|\u202f|&nbsp;/g, ' ').replace(/\s+/g, ' ');
};

afterEach(() => setLocale('en'));

describe('the pricing route', () => {
	it('is prerendered, and for every language but English (whose page is /welcome/pricing)', () => {
		expect(ssr).toBe(true);
		expect(prerender).toBe(true);
		expect(entries()).toEqual(LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((lang) => ({ lang })));
	});
});

describe('the pricing page as prerendered', () => {
	it('/welcome/pricing shows Free, Pro and Team at the plan figures’ prices, in rand', async () => {
		const { head, body } = await renderAt('https://example.org/welcome/pricing');
		expect(body).toContain(HEADING);
		expect(body.match(/data-plan="(\w+)"/g)).toEqual(PLAN_FIGURES.map((p) => `data-plan="${p.code}"`));
		const t = text(body);
		expect(t).toContain('R 0');
		expect(t).toContain('R 899 a month');
		expect(t).toContain('or R 8 990 a year (2 months free)');
		expect(t).toContain('R 2 499 a month');
		expect(t).toContain('or R 24 990 a year (2 months free)');
		expect(t).toContain('3 editors included; each further editor R 499 a month or R 4 990 a year');
		expect(t).toContain('Live data feeds, automatic runs, alerts and published farm views on 1 catchment');
		expect(t).toContain('5 server PDF reports a month');
		expect(t).toContain('Issued evidence packs at R 1 499 each');
		expect(t).toContain('Issued evidence packs at R 999 each');
		expect(t).toContain('3 issued evidence packs a month included, then R 999 each');
		expect(t).toContain('About 15 times Free’s assistant allowance');
		expect(t).toContain('Farmers and viewers are always free.');
		expect(t).toContain('Assessors verify evidence packs free.');
		expect(t).toContain('No VAT is charged.');
		expect(t).toContain('Unlimited catchments, runs, calibration, scenarios and exports');
		// #641's copy rules: never these words on the page.
		expect(t).not.toMatch(/quota|abuse|402/i);
		expect(head).toContain('<link rel="canonical" href="https://example.org/welcome/pricing"');
		expect(head).toContain('<link rel="alternate" hreflang="af" href="https://example.org/welcome/pricing/af"');
		expect(head).toContain('<link rel="alternate" hreflang="x-default" href="https://example.org/welcome/pricing"');
		expect(body).toMatch(/<a href="\/welcome\/pricing" hreflang="en" lang="en" aria-current="true"/);
		expect(body).toMatch(/<a href="\/welcome\/pricing\/af" hreflang="af" lang="af"(?! aria-current)/);
	});

	it('takes every price from the plan figures (a moved figure moves the page)', async () => {
		const t = text((await renderAt('https://example.org/welcome/pricing')).body);
		for (const p of PLAN_FIGURES) expect(t).toContain(rand(p.priceMonthlyMinor).replace(/\u00a0|\u202f/g, ' '));
		expect(t).toContain(rand(planFigures('team').extraSeatMonthlyMinor!).replace(/\u00a0|\u202f/g, ' '));
	});

	it('/welcome/pricing/af is Afrikaans from the catalogue, canonical to itself, with Afrikaans current', async () => {
		const { head, body } = await renderAt('https://example.org/welcome/pricing/af', 'af');
		expect(body).toContain(af[messageId(HEADING)]);
		expect(body).not.toContain(`>${HEADING}<`);
		expect(text(body)).toContain('R 899');
		expect(head).toContain('<link rel="canonical" href="https://example.org/welcome/pricing/af"');
		expect(head).toContain('<meta property="og:locale" content="af_ZA"');
		expect(body).toMatch(/<a href="\/welcome\/pricing\/af" hreflang="af" lang="af" aria-current="true"/);
	});
});
