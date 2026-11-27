// The leave guard and the URL-backed sheets (issue #931; docs/ui.md § Unsaved work and leaving):
// closing the node sheet, the grid modal or the farm drawer with a field holding text it can't take
// asks first, and Stay keeps it open with the URL still naming it; a navigation the guard stopped is
// made again with its own options, so a replacing one (‹ › in the sheet, a close) still replaces and
// Back doesn't reopen what was closed; a `node=` naming no node leaves the URL; a link marked
// `data-sveltekit-reset="false"` (SvelteKit 3's name for the old noscroll/keepfocus) keeps the scroll and focus.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { createProject, putModel, sampleModel, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { expect, test } from '../support/fixtures.ts';
import { historyDetail, historyEntries, openHistory, seedLongHistory } from '../support/history.ts';
import { openNodeForm, openNodeTable } from '../support/network.ts';
import { urlSettled } from '../support/urlSettled.ts';

const QUESTION = 'You have unsaved changes (fields that need fixing).';
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

test('the node sheet: Stay keeps it open and named in the URL; Leave closes it, and Back doesn’t reopen it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Sheet guard');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	await expect.poll(() => param(page, 'edit')).not.toBeNull();
	const edited = param(page, 'edit');
	const initial = sheet.getByLabel('Initial (%)');
	await initial.fill('150');
	await expect(initial).toHaveAttribute('aria-invalid', 'true');

	// Done, Stay: the sheet never shut, the URL still names it, and the text is still there.
	await sheet.getByRole('button', { name: 'Done', exact: true }).click();
	await answerConfirm(page, false, QUESTION);
	await expect(sheet).toBeVisible();
	await expect(initial).toHaveValue('150');
	await urlSettled(page);
	expect(param(page, 'edit')).toBe(edited);

	// Escape, Stay: the same.
	await initial.focus();
	await page.keyboard.press('Escape');
	await answerConfirm(page, false, QUESTION);
	await expect(sheet).toBeVisible();
	expect(param(page, 'edit')).toBe(edited);

	// Done, Leave: it closes and `edit=` leaves the URL in place, so Back goes to before it was opened.
	await sheet.getByRole('button', { name: 'Done', exact: true }).click();
	await answerConfirm(page, true, QUESTION);
	await expect(sheet).toBeHidden();
	await urlSettled(page);
	expect(param(page, 'edit')).toBeNull();
	await page.goBack();
	await urlSettled(page);
	expect(param(page, 'edit')).toBeNull();
	await expect(sheet).toBeHidden();
});

test('‹ › in the sheet after Leave still replaces: Back goes to before the sheet, not to the node left', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Sheet step guard');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	await expect.poll(() => param(page, 'edit')).not.toBeNull();
	const first = param(page, 'edit');
	await sheet.getByLabel('Initial (%)').fill('150');

	const next = sheet.getByRole('button', { name: 'Next hydrological unit' });
	const prev = sheet.getByRole('button', { name: 'Previous hydrological unit' });
	const step = (await next.isEnabled()) ? next : prev; // settled: the sheet is drawn (its field was just filled), and its ‹ › state is drawn with it from the fixed seeded network
	await step.click();
	await answerConfirm(page, true, QUESTION);
	await expect.poll(() => param(page, 'edit')).not.toBe(first);
	await expect(sheet).toBeVisible();

	// The step replaced the entry that named the first node: Back leaves the sheet altogether.
	await page.goBack();
	await urlSettled(page);
	expect(param(page, 'edit')).toBeNull();
	await expect(sheet).toBeHidden();
});

test('the grid modal: Stay keeps it open and named in the URL; Leave closes it, and Back doesn’t reopen it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Grid guard');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	const grid = await openNodeTable(page);
	await expect.poll(() => param(page, 'grid')).toBe('nodes');
	const initial = grid.getByLabel('Dam initial storage of Upper farm, %');
	await initial.fill('150');
	await expect(initial).toHaveAttribute('aria-invalid', 'true');

	await grid.getByRole('button', { name: 'Done', exact: true }).click();
	await answerConfirm(page, false, QUESTION);
	await expect(grid).toBeVisible();
	await expect(initial).toHaveValue('150');
	await urlSettled(page);
	expect(param(page, 'grid')).toBe('nodes');

	await grid.getByRole('button', { name: 'Done', exact: true }).click();
	await answerConfirm(page, true, QUESTION);
	await expect(grid).toBeHidden();
	await urlSettled(page);
	expect(param(page, 'grid')).toBeNull();
	await page.goBack();
	await urlSettled(page);
	expect(param(page, 'grid')).toBeNull();
	await expect(grid).toBeHidden();
});

test('the farm drawer: Stay keeps it open and named in the URL; Leave closes it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Drawer guard');
	const upperId = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	await page.goto(`/projects/${project.id}?tab=crops&farm=${upperId}`);
	const drawer = page.getByRole('dialog', { name: 'Upper farm: planted areas' });
	const area = drawer.getByLabel('Orchard on Upper farm, ha');
	await area.fill('-5');
	await expect(area).toHaveAttribute('aria-invalid', 'true');

	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await answerConfirm(page, false, QUESTION);
	await expect(drawer).toBeVisible();
	await expect(area).toHaveValue('-5');
	await urlSettled(page);
	expect(param(page, 'farm')).toBe(upperId);

	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await answerConfirm(page, true, QUESTION);
	await expect(drawer).toBeHidden();
	await urlSettled(page);
	expect(param(page, 'farm')).toBeNull();
});

test('a `node=` naming no node in the model is replaced out of the URL', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Unknown pick');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network&node=no-such-node`);
	await expect(page.getByRole('list', { name: 'All hydrological units' })).toBeVisible();
	await expect.poll(() => param(page, 'node')).toBeNull();
	expect(param(page, 'tab')).toBe('network');
	// Replaced, not pushed: Back doesn't return to the stale pick.
	await page.goBack();
	expect(page.url()).not.toContain('node=no-such-node');
});

test('removing a node from its sheet asks the leave guard too: Stay keeps the node, the sheet and `edit=`', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Sheet remove guard');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	const sheet = await openNodeForm(page, 'Upper farm');
	await expect.poll(() => param(page, 'edit')).not.toBeNull();
	const edited = param(page, 'edit');
	await sheet.getByLabel('Initial (%)').fill('150');

	// The remove question, then the leave guard's: Stay removes nothing.
	await sheet.getByRole('button', { name: 'Remove Upper farm' }).click();
	await answerConfirm(page, true, 'Remove “Upper farm”?');
	await answerConfirm(page, false, QUESTION);
	await expect(sheet).toBeVisible();
	await expect(sheet.getByLabel('Initial (%)')).toHaveValue('150');
	await urlSettled(page);
	expect(param(page, 'edit')).toBe(edited);

	// Leave: the node goes, and the sheet with `edit=` and its `node=` pick, in place.
	await sheet.getByRole('button', { name: 'Remove Upper farm' }).click();
	await answerConfirm(page, true, 'Remove “Upper farm”?');
	await answerConfirm(page, true, QUESTION);
	await expect(sheet).toBeHidden();
	await urlSettled(page);
	expect(param(page, 'edit')).toBeNull();
	expect(param(page, 'node')).toBeNull();
	await expect(page.getByRole('list', { name: 'All hydrological units' }).getByRole('button', { name: /^Edit Upper farm/ })).toHaveCount(0);
});

test('a link with data-sveltekit-reset="false" keeps the scroll and the focus (History’s Older)', async ({ page, owner }) => {
	void owner;
	test.setTimeout(90_000);
	// Narrower than the card-fills-the-window layout (1100 × 620), so the page itself scrolls.
	await page.setViewportSize({ width: 1024, height: 600 });
	const p = await seedLongHistory(page.request, 'Reset false', 12);
	await openHistory(page, p.id);
	await historyEntries(page).nth(2).getByRole('link').click();
	await expect(page).toHaveURL(/entry=revision\d+/);
	const older = historyDetail(page).getByRole('link', { name: 'Older', exact: true });
	await older.scrollIntoViewIfNeeded();
	// The precondition: the page is scrolled, so a reset would move it.
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
	const before = await page.evaluate(() => window.scrollY);
	const was = new URL(page.url()).searchParams.get('entry');
	await older.click();
	await expect.poll(() => new URL(page.url()).searchParams.get('entry')).not.toBe(was);
	await expect(historyEntries(page).nth(3).getByRole('link')).toHaveAttribute('aria-current', 'true');
	// Kept: SvelteKit's reset would put the scroll at the top and the focus on <body>.
	expect(await page.evaluate(() => window.scrollY)).toBe(before);
	await expect(older).toBeFocused();
});
