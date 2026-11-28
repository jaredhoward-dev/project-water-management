// Focus and statuses after saves on the Data tab (issue #932; docs/ui.md § Data): Edit a day keeps the focus on
// Save when a save fails, and says the new value as stored the moment it is saved; a Series details status
// ("Saved", "Not saved…") speaks of the series shown, so leaving and coming back clears it. Synthetic series only.
import { createProject, putSeries } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import type { Page } from '@playwright/test';

const RAIN = { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [0, 12.4, 0, 3.6, 0, 0, 8.2, 0, 0, 1.5] };
const FLOW = { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: [1.2, 1.1, 1.0, 0.9, 0.9, 0.8, 0.8, 0.7, 0.7, 0.6] };

const rowOf = (page: Page, text: string) => page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: text });

test('a failed day save keeps the focus on Save; a saved day reads as stored at once, with nothing left to save', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Edit day focus');
	await putSeries(page.request, project.id, RAIN);
	await page.goto(`/projects/${project.id}?tab=series`);
	await rowOf(page, 'Rainfall — catchment').getByRole('button', { name: 'View', exact: true }).click();
	const edit = page.getByRole('group', { name: 'Edit a day' });
	const save = edit.getByRole('button', { name: 'Save the day' });
	await edit.getByLabel('Day', { exact: true }).fill('2 Oct 2021');
	await edit.getByLabel('Value (mm)', { exact: true }).fill('20');

	// The server refuses once: the error shows and the focus stays on the button pressed.
	let refuse = true;
	await page.route('**/days/2021-10-02', async (route) => {
		if (!refuse || route.request().method() !== 'PUT') return route.fallback();
		refuse = false;
		await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong' }) });
	});
	await save.click();
	await expect(edit.getByTestId('edit-day-error')).toBeVisible();
	await expect(save).toBeFocused();
	await expect(save).not.toHaveAttribute('aria-disabled', 'true');

	// Pressed again it saves: Stored says the new value straight away, beside a Save with nothing left to do.
	const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/days/2021-10-02'));
	await save.click();
	expect((await saved).status()).toBe(200);
	await expect(edit.getByTestId('edit-day-done')).toContainText('Saved 2 Oct 2021: 20 mm.');
	await expect(edit.getByTestId('edit-day-stored')).toContainText('Stored: 20 mm, edited by hand.');
	await expect(edit.getByTestId('edit-day-stored')).not.toContainText('12.4');
	await expect(save).toHaveAttribute('aria-disabled', 'true');
	await expect(edit.getByLabel('Day', { exact: true })).toBeFocused();
});

test('a Series details status clears on leaving the series, so coming back shows none', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Details status');
	await putSeries(page.request, project.id, RAIN);
	await putSeries(page.request, project.id, FLOW);
	await page.goto(`/projects/${project.id}?tab=series`);
	const details = page.getByRole('group', { name: 'Series details' });
	const source = details.getByRole('textbox', { name: 'Source' });

	await rowOf(page, 'Rainfall — catchment').getByRole('button', { name: 'View', exact: true }).click();
	await source.fill('Farm logger file');
	await source.press('Enter');
	await expect(source).toHaveAccessibleDescription('Saved');

	await rowOf(page, 'Flow — observed gauge').getByRole('button', { name: 'View', exact: true }).click();
	await expect(source).toHaveValue('');
	await rowOf(page, 'Rainfall — catchment').getByRole('button', { name: 'View', exact: true }).click();
	await expect(source).toHaveValue('Farm logger file');
	await expect(details.getByTestId('save-status').first()).toHaveText('');
	await expect(source).toHaveAccessibleDescription('');

	// A refused save says Not saved, marked on the box; it too is gone once the series is left and come back to.
	await page.route(/\/series\/[^/]+$/, (route) =>
		route.request().method() === 'PATCH'
			? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong' }) })
			: route.fallback()
	);
	await source.fill('Another source');
	await source.press('Enter');
	await expect(source).toHaveAccessibleDescription(/^Not saved: /);
	await expect(source).toHaveAttribute('aria-invalid', 'true');
	await rowOf(page, 'Flow — observed gauge').getByRole('button', { name: 'View', exact: true }).click();
	await rowOf(page, 'Rainfall — catchment').getByRole('button', { name: 'View', exact: true }).click();
	await expect(source).toHaveAccessibleDescription('');
	await expect(source).not.toHaveAttribute('aria-invalid', 'true');
});
