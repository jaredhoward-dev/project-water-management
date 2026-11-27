// Issue #942: the farmer pages' ways on, at phone width. A dead or cut-short
// /share link offers the home page; the withheld preview links back to the
// workspace in the page, not only in the banner; a saved copy from an older
// publication isn't shown on a /farm card; and the words page's back link to
// the who-decides page is short enough for one line.
//
// Seeded as farm-view.spec.ts is: farmer1@ has one farm (Vaalbank, Sandspruit),
// farmer2@ two (Rietspruit on Sandspruit, Kareebos on Droëvlei), analyst@ is
// WUA staff who can preview them.
import type { Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { ANALYST, FARMER1, FARMER2, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(90_000);
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
});

const PHONE = { width: 360, height: 740 };

async function signIn(page: Page, who: { email: string; password: string }) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(who.email);
	await page.getByLabel('Password').fill(who.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

async function expectTapTarget(page: Page, name: string) {
	const box = await page.getByRole('link', { name }).boundingBox();
	expect(box).not.toBeNull();
	expect(box!.height).toBeGreaterThanOrEqual(44);
}

test('a dead or cut-short share link offers the home page, signed out on a phone', async ({ browser }) => {
	const stranger = await browser.newContext({ viewport: PHONE, locale: 'en-ZA', timezoneId: 'UTC' });
	const shared = await stranger.newPage();

	// A well-formed token no link has: dead. (A malformed one reads as cut short, readShareToken.)
	await shared.goto(`/share#t=${'d'.repeat(43)}`);
	await expect(shared.getByRole('heading', { level: 1, name: 'This link doesn’t open anything' })).toBeVisible();
	await expect(shared.getByRole('alert')).toHaveText(/^This link has expired or was withdrawn\./);
	await expect(shared.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', /\/welcome$/);
	await expectTapTarget(shared, 'Go to the home page');

	// No token at all: cut short, the same way on.
	await shared.goto('/share');
	await expect(shared.getByRole('alert')).toHaveText(/^This page needs the whole link\./);
	await shared.getByRole('link', { name: 'Go to the home page' }).click();
	await expect(shared).toHaveURL(/\/welcome$/);
	await stranger.close();
});

test('a withheld preview links back to the workspace from the page itself', async ({ page, browser }) => {
	await page.setViewportSize(PHONE);
	const farmerContext = await browser.newContext();
	const farmer = await farmerContext.newPage();
	await signIn(farmer, FARMER1);
	const { projects } = (await (await farmerContext.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; role: string }[] };
	const projectId = projects.find((p) => p.role === 'farmer')!.id;
	const index = (await (await farmerContext.request.get(`${API_URL}/projects/${projectId}/farm`)).json()) as { farms: { nodeId: string }[] };
	const nodeId = index.farms[0]!.nodeId;
	await farmerContext.close();

	await signIn(page, ANALYST);
	// The published run caps or fully allocates, as far as this viewer is told: the API's own answer for that (#523 I).
	await page.route(`${API_URL}/projects/${projectId}/farm/${nodeId}`, (route) =>
		route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'withheld', code: 'farm_preview_withheld' }) })
	);
	await page.goto(`/farm/${projectId}?node=${nodeId}`);
	await expect(page.getByRole('alert')).toBeVisible();
	const inPage = page.getByTestId('withheld-workspace');
	await expect(inPage).toHaveText('Back to the workspace');
	await expect(inPage).toHaveAttribute('href', new RegExp(`/projects/${projectId}\\?tab=network$`));
	await inPage.click();
	await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`));
	await page.unrouteAll({ behavior: 'wait' });
});

test('a /farm card shows no saved copy from an older publication than the catchment has now', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page, FARMER2);
	await expect(page).toHaveURL(/\/farm$/);
	// Opening Kareebos keeps a copy of its figures (of the current publication) on this phone.
	await page.getByRole('link', { name: /Kareebos/ }).click();
	await expect(page.getByRole('heading', { level: 1, name: /^Kareebos/ })).toBeVisible();
	const { projects } = (await (await page.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; role: string }[] };
	let projectId = '';
	let nodeId = '';
	for (const p of projects.filter((x) => x.role === 'farmer')) {
		const ix = (await (await page.request.get(`${API_URL}/projects/${p.id}/farm`)).json()) as { farms: { nodeId: string; name: string }[] };
		const k = ix.farms.find((f) => f.name === 'Kareebos');
		if (k) [projectId, nodeId] = [p.id, k.nodeId];
	}
	expect(nodeId).not.toBe('');

	// Its live figures fail, so the card would fall back to the saved copy…
	await page.route(`${API_URL}/projects/*/farm/${nodeId}`, (route) =>
		route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error' }) })
	);
	// Positive control: of the same publication, the copy shows, marked as saved.
	await page.goto('/farm');
	const kareebos = page.getByRole('link', { name: /Kareebos/ });
	await expect(kareebos.getByTestId('farm-card-saved')).toBeVisible();

	// …but the catchment has published again since: the list names a newer publication than the copy's.
	await page.route(`${API_URL}/projects/${projectId}/farm`, async (route) => {
		const res = await route.fetch();
		const body = (await res.json()) as { publication: { publishedAt: string } | null };
		body.publication = { ...body.publication!, publishedAt: new Date(Date.now() + 60_000).toISOString() };
		await route.fulfill({ response: res, json: body });
	});
	await page.goto('/farm');
	await expect(kareebos).toContainText('We couldn’t load your hydrological unit');
	await expect(kareebos.getByTestId('farm-card-saved')).toHaveCount(0);
	await expect(kareebos).not.toContainText('% of water needed');
	await page.unrouteAll({ behavior: 'wait' });
});

test('the words page names its way back to the who-decides page in one short line', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, FARMER1);
	await expect(page).toHaveURL(/\/farm\/[\w-]+/);
	const projectId = new URL(page.url()).pathname.split('/')[2]!;
	await page.goto(`/farm/words?from=${encodeURIComponent(`/farm/${projectId}/who-decides`)}`);
	const back = page.getByRole('link', { name: 'Who decides?' });
	await expect(back).toHaveAttribute('href', new RegExp(`/farm/${projectId}/who-decides$`));
	// One line: no taller than a tap target.
	const box = await back.boundingBox();
	expect(box!.height).toBeLessThanOrEqual(48);
	await back.click();
	await expect(page).toHaveURL(new RegExp(`/farm/${projectId}/who-decides$`));
});
