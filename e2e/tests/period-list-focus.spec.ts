// Where the focus goes in the period lists (issue #921, WCAG 2.4.3): an add
// puts it in the new row's first field, a remove on the ✕ of the row now in
// its place (the next row, else the previous), and the add button once the
// list is empty. Keyed by position, removing the last row dropped the focus
// to <body> and an add left it on the button. One shared fix
// (frontend/src/lib/a11y/listRows.ts) for common/PeriodList.svelte (the
// calibration exclusions, Flagged zero runs' lists, each record's missing
// periods), calibration/LowFlowPeriods.svelte and
// settings/RainRecordPeriods.svelte, and the drought restriction's review and
// lift dates and its levels (settings/DroughtRestrictionFields.svelte). A
// deleted rain series goes with its last period, add button and all: the
// group's heading takes the focus. Synthetic data.
import { createProject, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openCalibration, openFold, openSettings } from '../support/settings.ts';

test('the calibration exclusions move the focus into a new row and to a neighbour on a remove', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Period focus exclusions');
	await openCalibration(page, project.id);
	const group = page.getByRole('region', { name: 'Calibration record' }).getByRole('group', { name: /^Calibration exclusions/ });
	const addYear = group.getByRole('button', { name: 'Exclude a water year' });

	// Each add lands in the new row's first field (a water year's number).
	await addYear.click();
	await expect(group.getByLabel(/^Water year/)).toBeFocused();
	await addYear.click();
	await addYear.click();
	await expect(group.getByLabel(/^Water year/).nth(2)).toBeFocused();
	await group.getByRole('button', { name: 'Exclude a date range' }).click();
	await expect(group.getByLabel('From', { exact: true })).toBeFocused();

	// Typed text stays with its row when an earlier row goes (rows keep their own keys).
	await group.getByLabel('Reason').nth(1).fill('Second row');
	await group.getByRole('button', { name: 'Remove exclusion 1' }).click();
	await expect(group.getByLabel('Reason').first()).toHaveValue('Second row');
	// The next row took the removed one's place: its ✕ has the focus.
	await expect(group.getByRole('button', { name: 'Remove exclusion 1' })).toBeFocused();

	// Removing the last row: the previous row's ✕.
	await group.getByRole('button', { name: 'Remove exclusion 3' }).click();
	await expect(group.getByRole('button', { name: 'Remove exclusion 2' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(group.getByRole('button', { name: 'Remove exclusion 1' })).toBeFocused();

	// The last one left: the focus goes back to the add button, never to the page.
	await page.keyboard.press('Enter');
	await expect(group.getByText('None: every observed day in the calibration window is scored.')).toBeVisible();
	await expect(addYear).toBeFocused();
});

test('the low-flow periods move the focus into a new row and back to the add button', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Period focus low flows');
	await page.goto(`/projects/${project.id}?tab=calibration`);
	const group = page.getByRole('group', { name: /^Low flows only/ });
	const add = group.getByRole('button', { name: 'Use only low flows in a date range' });

	await add.click();
	await expect(group.getByLabel('Record')).toBeFocused();
	await add.click();
	await expect(group.getByLabel('Record').nth(1)).toBeFocused();

	await group.getByRole('button', { name: 'Remove low-flow period 2' }).click();
	await expect(group.getByRole('button', { name: 'Remove low-flow period 1' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(group.getByTestId('low-flow-period')).toHaveCount(0);
	await expect(add).toBeFocused();
});

test('a rain record’s unreliable periods move the focus into a new row and back to the record’s add button', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Period focus rain');
	await openSettings(page, project.id);
	await openFold(page, 'rain-defaults');
	const record = page.getByRole('group', { name: /^Unreliable periods of a rain record/ }).getByTestId('rain-record');
	const add = record.getByRole('button', { name: 'Mark a period unreliable' });

	await add.click();
	await expect(record.getByLabel('From', { exact: true })).toBeFocused();
	await add.click();
	await expect(record.getByLabel('From', { exact: true }).nth(1)).toBeFocused();

	await record.getByRole('button', { name: /^Remove unreliable period 1 of / }).click();
	await expect(record.getByRole('button', { name: /^Remove unreliable period 1 of / })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(record.getByText('None: every reading of this record is used.')).toBeVisible();
	await expect(add).toBeFocused();
});

test('a deleted rain series’ last period removed puts the focus on the group’s heading', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Period focus deleted series');
	// A series id no record has: the list shows it as a deleted series, so its periods can still be removed.
	await updateSettings(page.request, project.id, { rainStations: { unreliable: { '00000000-0000-0000-0000-00000000dead': [['2021-01-01', '2021-01-31']] } } });
	await openSettings(page, project.id);
	await openFold(page, 'rain-defaults');
	const group = page.getByRole('group', { name: /^Unreliable periods of a rain record/ });
	const gone = group.getByTestId('rain-record').filter({ hasText: 'A deleted series' });
	await expect(gone).toHaveCount(1);

	await gone.getByRole('button', { name: /^Remove unreliable period 1 of A deleted series/ }).click();
	await expect(gone).toHaveCount(0);
	await expect(page.locator('body')).not.toBeFocused();
	await expect(group.getByText('Unreliable periods of a rain record', { exact: true })).toBeFocused();
});

test('the drought restriction’s dates and levels move the focus into what was added and to a neighbour on a remove', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Period focus drought');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const section = page.getByRole('region', { name: /^Drought restrictions/ });
	// The template: reviewed 1 Oct and 1 Jan, lifted 1 May, three levels.
	await section.getByLabel('Apply drought restrictions in runs').check();

	// Review dates: an add lands on the new date's day, a remove on the next date's ✕, else the previous one's.
	await section.getByRole('button', { name: 'Add a review date' }).click();
	await expect(section.getByLabel('Review date 3: day')).toBeFocused();
	await section.getByRole('button', { name: 'Add a review date' }).click();
	await expect(section.getByLabel('Review date 4: day')).toBeFocused();
	await section.getByRole('button', { name: /^Remove review date 1,/ }).click();
	await expect(section.getByRole('button', { name: /^Remove review date 1,/ })).toBeFocused();
	await section.getByRole('button', { name: /^Remove review date 3,/ }).click();
	await expect(section.getByRole('button', { name: /^Remove review date 2,/ })).toBeFocused();
	// Down to one: the last review date keeps no ✕ (a rule needs one), so its day field takes the focus.
	await page.keyboard.press('Enter');
	await expect(section.getByRole('button', { name: /^Remove review date/ })).toHaveCount(0);
	await expect(section.getByLabel('Review date 1: day')).toBeFocused();

	// Lift dates may all go: then Add a lift date.
	await section.getByRole('button', { name: /^Remove lift date 1,/ }).click();
	await expect(section.getByRole('button', { name: 'Add a lift date' })).toBeFocused();

	// Levels: an added level's name takes the focus; Remove the deepest level keeps it while it stays, then Add a deeper level.
	await section.getByRole('button', { name: 'Add a deeper level' }).click();
	await expect(section.getByLabel('Level 4: name')).toBeFocused();
	const removeDeepest = section.getByRole('button', { name: 'Remove the deepest level' });
	await removeDeepest.click();
	await removeDeepest.click();
	await expect(removeDeepest).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(section.getByTestId('restriction-level')).toHaveCount(1);
	await expect(section.getByRole('button', { name: 'Add a deeper level' })).toBeFocused();
});
