// Calibration → Fit automatically (issues #920, #922). A fit's result, not yet applied, says so when the calibration
// window changes after it ran (the engine's fitRecordStatus against the form as it stands), and the warning goes
// once the window is put back. Fit's own search fields (runs per fit, starts, seed: never saved) hold the button
// when they can't be read, but don't light the page's save bar (which the leave guard reads too). Synthetic data.
import type { Page } from '@playwright/test';
import { seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar, openFold } from '../support/settings.ts';

const fitCard = (page: Page) => page.getByRole('region', { name: /^Fit automatically/ });
const fitButton = (page: Page) => fitCard(page).getByRole('button', { name: 'Fit automatically', exact: true });

async function openFit(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=calibration`);
	await expect(fitButton(page)).toBeEnabled();
	return project;
}

test('an unapplied fit warns when the calibration window changes after it ran (issue #920)', async ({ page, owner }) => {
	void owner;
	await openFit(page, 'Fit stale window');
	const fit = fitCard(page);
	await openFold(fit, 'fit-search');
	await fit.getByLabel('Model runs per fit').fill('60');
	await fit.getByLabel('Starts').fill('1');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fitButton(page).click();
	await expect(fit.getByRole('table', { name: /^Fit, and validation/ })).toBeVisible();
	await expect(fit.getByTestId('fit-stale')).toHaveCount(0);

	const from = page.getByRole('group', { name: 'Calibration window', exact: true }).getByLabel('From', { exact: true });
	const before = await from.inputValue();
	await from.fill('2021-11-01');
	await from.press('Enter');
	await expect(from).toHaveValue('1 Nov 2021');
	const stale = fit.getByTestId('fit-stale');
	await expect(stale).toBeVisible();
	await expect(stale).toContainText('The form has changed since this fit ran');
	await expect(stale.getByRole('listitem')).toHaveText(['The calibration window has changed since the fit.']);

	// Put back: the warning goes.
	await from.fill(before);
	await from.press('Enter');
	await expect(fit.getByTestId('fit-stale')).toHaveCount(0);

	// Applied, the form's fit record speaks for it: the panel's warning stays away.
	await from.fill('2021-11-01');
	await from.press('Enter');
	await expect(fit.getByTestId('fit-stale')).toBeVisible();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	await expect(fit.getByTestId('fit-stale')).toHaveCount(0);
});

test('Fit’s own search fields hold the button but are not unsaved settings (issue #922)', async ({ page, owner }) => {
	void owner;
	await openFit(page, 'Fit own fields');
	const fit = fitCard(page);
	await openFold(fit, 'fit-search');
	for (const [label, bad, good] of [
		['Model runs per fit', '20', '1500'],
		['Starts', '11', '5'],
		['Seed', '-1', '1']
	] as const) {
		const field = fit.getByLabel(new RegExp(`^${label}`));
		await field.fill(bad);
		await field.blur();
		await expect(field).toHaveAttribute('aria-invalid', 'true');
		await expect(fitButton(page)).toBeDisabled();
		// Never saved, so not unsaved work: no save bar.
		await expect(anySaveBar(page)).toHaveCount(0);
		await field.fill(good);
		await field.blur();
		await expect(field).not.toHaveAttribute('aria-invalid');
		await expect(fitButton(page)).toBeEnabled();
	}
});
