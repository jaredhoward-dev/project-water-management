// The URL rule on the Network and Data tabs (issue #933, frontend/src/lib/nav/tabUrl.ts, docs/ui.md § Network):
// a pick replaces the history entry, closing a panel removes its parameter, links are built from the current URL.
// The picks' own history steps are in network-map.spec.ts and data-page.spec.ts; the closed Data feeds card
// dropping `rain=` is in data-page.spec.ts.
import type { Page } from '@playwright/test';
import { createProject, seedRunnableProject } from '../support/api.ts';
import { openData, seedFreshnessMix, seriesRow } from '../support/data.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeForm } from '../support/network.ts';

const nodeList = (page: Page) => page.getByRole('list', { name: 'All hydrological units' });

test('an old view=node link on an empty network says why it shows the map, and drops view=', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Old node link, empty');
	await page.goto(`/projects/${project.id}?tab=network&view=node`);
	await expect(page.getByTestId('network-empty')).toBeVisible();
	await expect(page.getByTestId('network-old-node-link')).toHaveText(
		'The link opened a hydrological unit’s form, but this network has no hydrological units yet, so it shows the map.'
	);
	await expect(page).not.toHaveURL(/[?&]view=/);
	// A plain arrival says nothing (positive control: the note is the link's, not the empty state's).
	await page.goto(`/projects/${project.id}?tab=network`);
	await expect(page.getByTestId('network-empty')).toBeVisible();
	await expect(page.getByTestId('network-old-node-link')).toHaveCount(0);
});

test('the farm drawer opened from a unit’s sheet takes the sheet’s section= with it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sheet to drawer');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!.id as string;
	await page.goto(`/projects/${project.id}?tab=network&edit=${upper}&section=irrigation`);
	const sheet = await openNodeForm(page);
	await sheet.getByTestId('node-planted-link').click();
	await expect(page).toHaveURL(new RegExp(`[?&]farm=${upper}`));
	await expect(page).not.toHaveURL(/[?&]edit=/);
	await expect(page).not.toHaveURL(/[?&]section=/);
});

test('removing a unit from its sheet hands the focus to the list row now in its place, else the one before', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sheet remove focus');
	await page.goto(`/projects/${project.id}?tab=network`);
	// The last row: the focus goes to the one before it.
	const sheet = await openNodeForm(page, 'Lower farm');
	await sheet.getByRole('button', { name: 'Remove Lower farm' }).click();
	const box = page.getByRole('alertdialog', { name: 'Remove “Lower farm”?' });
	if (await box.isVisible()) await box.getByRole('button', { name: 'Remove hydrological unit' }).click();
	await expect(page.getByRole('dialog', { name: /^Edit / })).toHaveCount(0);
	await expect(nodeList(page).getByRole('button', { name: /^Upper farm/ })).toBeFocused();
});

test('charting another series drops view= and rain=, and replaces the history entry', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series pick drops');
	await seedFreshnessMix(page.request, project.id);
	await openData(page, project.id, '&rain=units&view=2020-01-01~2020-02-01');
	const entries = await page.evaluate(() => history.length);
	await seriesRow(page, 'Logger L1').getByRole('button', { name: 'View', exact: true }).click();
	await expect(page).toHaveURL(/[?&]series=/);
	await expect(page).not.toHaveURL(/[?&]view=/);
	await expect(page).not.toHaveURL(/[?&]rain=/);
	await expect(page).toHaveURL(/[?&]tab=series/);
	expect(await page.evaluate(() => history.length)).toBe(entries);
});

test('columns hidden in the preview belong to their view: another view shows its columns whole', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Preview columns per view');
	await seedFreshnessMix(page.request, project.id);
	await openData(page, project.id);
	await page.getByRole('button', { name: 'Preview all data' }).click();
	const dialog = page.getByRole('dialog');
	const logger = dialog.getByRole('checkbox', { name: /Logger L1/ }).first();
	await expect(logger).toBeChecked();
	await logger.uncheck();
	await expect(logger).not.toBeChecked();
	await dialog.getByTestId('preview-view').selectOption({ label: 'All flow' });
	await expect(dialog.getByRole('checkbox', { name: /Logger L1/ }).first()).toBeChecked();
	// Back on All, it starts whole too: the hide was All's, and switching away let it go.
	await dialog.getByTestId('preview-view').selectOption({ label: 'All' });
	await expect(dialog.getByRole('checkbox', { name: /Logger L1/ }).first()).toBeChecked();
});
