// The public pricing page (issue #641 Phase 4; docs/ui.md § Pricing page):
// /welcome/pricing is prerendered in English and /welcome/pricing/<code> in
// each other language, each with its own <html lang>, like the landing page
// (landing-language.spec.ts). Free, Pro and Team at the plan figures' prices
// (the unit test pins those to the `plan` table), reachable from the landing
// page, with no axe violations and no sideways scroll on a phone, in light
// and dark. Against the production e2e build.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { languages, words } from '../support/lang.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';

const HEADING = 'Plans and prices';
const PHONE = { width: 390, height: 844 };
const OTHER = (await languages()).filter((l) => l.code !== 'en');
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
/** The page's prices as shown, the no-break spaces as spaces. */
const price = async (page: Page, plan: string) => ((await page.getByTestId(`price-${plan}`).textContent()) ?? '').replace(/[  ]/g, ' ');

test('/welcome/pricing is English in its HTML, with Free, Pro and Team at their prices', async ({ request, page }) => {
	const res = await request.get('/welcome/pricing');
	expect(res.status()).toBe(200);
	const html = await res.text();
	expect(html).toMatch(/<html lang="en">/);
	expect(html).toContain(HEADING);
	expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^/"]+\/welcome\/pricing"/);
	for (const l of OTHER) expect(html).toMatch(new RegExp(`<link rel="alternate" hreflang="${l.code}" href="https?://[^/"]+/welcome/pricing/${l.code}"`));

	await page.goto('/welcome/pricing');
	await expect(h1(page, HEADING)).toBeVisible();
	expect(await price(page, 'free')).toBe('R 0');
	expect(await price(page, 'pro')).toBe('R 899');
	expect(await price(page, 'team')).toBe('R 2 499');
	await expect(page.getByTestId('pricing-always-free')).toContainText('Farmers and viewers are always free.');
});

test('the landing page links to the pricing page in its own language', async ({ page }) => {
	await page.goto('/welcome');
	await page.getByTestId('landing-pricing').click();
	await expect(page).toHaveURL('/welcome/pricing');
	await expect(h1(page, HEADING)).toBeVisible();
	for (const l of OTHER) {
		const w = await words(l.code);
		await page.goto(`/welcome/${l.code}`);
		await page.getByTestId('landing-pricing').click();
		await expect(page).toHaveURL(`/welcome/pricing/${l.code}`);
		await expect(h1(page, w(HEADING))).toBeVisible();
	}
});

for (const l of OTHER) {
	test(`/welcome/pricing/${l.code} is prerendered in ${l.name}, with lang="${l.code}", and stays so once the app runs`, async ({ request, page }) => {
		const w = await words(l.code);
		const html = await (await request.get(`/welcome/pricing/${l.code}`)).text();
		expect(html).toMatch(new RegExp(`<html lang="${l.code}">`));
		expect(html).toContain(w(HEADING));
		expect(html).toMatch(new RegExp(`<link rel="canonical" href="https?://[^/"]+/welcome/pricing/${l.code}"`));

		await page.goto(`/welcome/pricing/${l.code}`);
		await expect(h1(page, w(HEADING))).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', l.code);
		await expect(page).toHaveURL(`/welcome/pricing/${l.code}`);
		expect(await price(page, 'pro')).toBe('R 899');
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test(`the pricing page has no axe violations and no sideways scroll on a phone, in every language (${scheme})`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize(PHONE);
		for (const l of [{ code: 'en' }, ...OTHER]) {
			// English has no catalogue: a message is its own English words.
			const w = l.code === 'en' ? (english: string) => english : await words(l.code);
			await page.goto(l.code === 'en' ? '/welcome/pricing' : `/welcome/pricing/${l.code}`);
			await expect(h1(page, w(HEADING))).toBeVisible();
			await expectNoSidewaysScroll(page);
			await expectNoViolations(page);
		}
	});
}
