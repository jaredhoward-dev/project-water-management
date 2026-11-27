// Calibration → Fit automatically (ux hunt, round 2026-11-27): a disabled Fit button says why beside it, even when
// the field to fix is inside the Search fold; a number field holding text it can't take holds the button (it keeps
// the stored value, so the fit ran on a number the field no longer showed); and Cancel works while the data loads and hands the focus back
// to Fit automatically rather than dropping it to the page. Synthetic data.
import type { Page } from '@playwright/test';
import { seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openFold } from '../support/settings.ts';

const fitCard = (page: Page) => page.getByRole('region', { name: /^Fit automatically/ });
const fitButton = (page: Page) => fitCard(page).getByRole('button', { name: 'Fit automatically', exact: true });

async function openFit(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(fitButton(page)).toBeEnabled();
	return project;
}

test('a disabled Fit automatically says why: no parameter ticked, or a Search field to fix', async ({ page, owner }) => {
	void owner;
	await openFit(page, 'Fit blocker');
	const fit = fitCard(page);
	await expect(fit.getByTestId('fit-blocker')).toHaveCount(0);

	// Every parameter unticked.
	const boxes = fit.getByRole('group', { name: /Parameters to fit/ }).getByRole('checkbox');
	for (const b of await boxes.all()) await b.uncheck();
	await expect(fitButton(page)).toBeDisabled();
	await expect(fit.getByTestId('fit-blocker')).toHaveText('Tick at least one parameter to fit.');
	await expect(fitButton(page)).toHaveAccessibleDescription(/Tick at least one parameter to fit\./);
	await boxes.first().check();
	await expect(fitButton(page)).toBeEnabled();
	await expect(fit.getByTestId('fit-blocker')).toHaveCount(0);

	// Model runs per fit below its least: the field keeps the text and says so, but the stored 1 500 stays, so before
	// this fix the button stayed enabled and the fit ran 1 500 runs the field no longer showed.
	await openFold(fit, 'fit-search');
	const budget = fit.getByLabel(/Model runs per fit/);
	await budget.fill('20');
	await budget.blur();
	await expect(budget).toHaveAttribute('aria-invalid', 'true');
	await expect(fitButton(page)).toBeDisabled();
	await expect(fit.getByTestId('fit-blocker')).toHaveText('Fix the model runs per fit under Search first.');
	await expect(fitButton(page)).toHaveAccessibleDescription(/Fix the model runs per fit under Search first\./);
	await budget.fill('1500');
	await budget.blur();
	await expect(budget).not.toHaveAttribute('aria-invalid');
	await expect(fitButton(page)).toBeEnabled();
	await expect(fit.getByTestId('fit-blocker')).toHaveCount(0);
});

test('Cancel works while the data loads, and the focus moves between Fit automatically and Cancel', async ({ page, owner }) => {
	void owner;
	const project = await openFit(page, 'Fit cancel focus');
	// Hold the model input, so the fit stays in its loading step until the test lets it go.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	await page.route(`**/projects/${project.id}/model-input**`, async (route) => {
		await held;
		await route.continue();
	});
	await fitButton(page).focus();
	await page.keyboard.press('Enter');
	const fit = fitCard(page);
	await expect(fit.getByText('Loading the project’s data…')).toBeVisible();
	const cancel = fit.getByRole('button', { name: 'Cancel', exact: true });
	await expect(cancel).toBeEnabled();
	await expect(cancel).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(fitButton(page)).toBeFocused();
	await expect(fit.getByText('Loading the project’s data…')).toHaveCount(0);
	release();
	// The cancelled fit's data arriving late starts nothing.
	await expect(fit.getByTestId('fit-progress-line')).toHaveCount(0);
	await expect(fit.locator('.result')).toHaveCount(0);
});
