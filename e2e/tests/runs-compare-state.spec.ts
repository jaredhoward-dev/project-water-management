// Selection and URL state on Runs & results and Compare runs when the page moves under a pick still out: a run
// shown from the cache while another run's results are loading, a run that finishes after its tab was left, and a
// compare card's project pick left waiting when Back changes the pair; a run still going when its tab is opened again.
import { createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { runCard, runSelect } from '../support/compare.ts';
import { sections } from '../support/data.ts';
import { expect, test } from '../support/fixtures.ts';
import { openRuns, runsList } from '../support/runs.ts';

test('Back to a cached run while another run is loading leaves its results settled, not busy', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs back while loading');
	const first = await createRun(page.request, project.id, 'Baseline');
	await createRun(page.request, project.id, 'Second');
	// The newest run (Second) opens by default, so its results are cached.
	await openRuns(page, project.id);
	await expect(page.getByRole('heading', { level: 2, name: 'Second' })).toBeVisible();

	// Baseline's results are held until Back has shown Second again from the cache.
	let release = () => {};
	const held = new Promise<void>((r) => (release = r));
	const detailPath = `/projects/${project.id}/runs/${first}`;
	await page.route(
		(url) => url.pathname.endsWith(detailPath),
		async (route) => {
			if (route.request().method() === 'GET') await held;
			await route.continue();
		}
	);
	await runsList(page).getByRole('button', { name: /^Baseline/ }).click();
	await expect(page).toHaveURL(new RegExp(`run=${first}`));
	await page.goBack();
	await expect(page.getByRole('heading', { level: 2, name: 'Second' })).toBeVisible();
	const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(detailPath));
	release();
	await answered;
	// The load for Baseline answered late: it owns nothing now, so the shown results aren't left marked busy.
	await expect(page.locator('section[aria-labelledby="res-h"]')).toHaveAttribute('aria-busy', 'false');
	await expect(page.getByRole('heading', { level: 2, name: 'Second' })).toBeVisible();
});

test('a run that finishes after Runs & results was left writes no run into the other tab’s address', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Run finishes elsewhere');
	await createRun(page.request, project.id, 'Baseline');
	await openRuns(page, project.id);

	// Hold the new run on the server's way back until the person is on another tab.
	let release = () => {};
	const held = new Promise<void>((r) => (release = r));
	const listPath = `/projects/${project.id}/runs`;
	await page.route(
		(url) => url.pathname.endsWith(listPath),
		async (route) => {
			if (route.request().method() === 'POST') await held;
			await route.continue();
		}
	);
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('button', { name: 'Running model…' })).toBeVisible();
	await sections(page).getByRole('link', { name: 'Network' }).click();
	await expect(page).toHaveURL(/\?tab=network$/);
	const created = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(listPath) && r.request().method() === 'POST');
	release();
	await created;

	// Back on Runs, the new run is listed; one step back is the Network tab as it was left, with no run pushed onto it.
	await sections(page).getByRole('link', { name: 'Runs & results' }).click();
	await expect(runsList(page).getByRole('listitem')).toHaveCount(2);
	await page.goBack();
	await expect(page).toHaveURL(/\?tab=network$/);
});

test('back on Runs & results while its run still goes, Run model waits, the progress shows and the run opens when it ends', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Run still going on return');
	await createRun(page.request, project.id, 'Baseline');
	await openRuns(page, project.id);

	// Hold the new run on the server's way back while the person leaves the tab and comes back (issue #923).
	let release = () => {};
	const held = new Promise<void>((r) => (release = r));
	const listPath = `/projects/${project.id}/runs`;
	let posts = 0;
	await page.route(
		(url) => url.pathname.endsWith(listPath),
		async (route) => {
			if (route.request().method() === 'POST') {
				posts++;
				await held;
			}
			await route.continue();
		}
	);
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('button', { name: 'Running model…' })).toBeDisabled();
	await sections(page).getByRole('link', { name: 'Network' }).click();
	await expect(page).toHaveURL(/\?tab=network$/);
	await sections(page).getByRole('link', { name: 'Runs & results' }).click();

	// The run is still going: no second run can start, and the progress line says so.
	await expect(page.getByRole('button', { name: 'Running model…' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Run model', exact: true })).toHaveCount(0);
	await expect(page.locator('#run-note')).toContainText('Simulating every day of the record');
	await expect(page.locator('.run-status .progress')).toBeVisible();

	const created = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(listPath) && r.request().method() === 'POST');
	release();
	const runId = ((await (await created).json()) as { run: { id: string } }).run.id;

	// It ended with the tab open: the new run opens here, Run model is back, and only the one run was asked for.
	await expect(page).toHaveURL(new RegExp(`run=${runId}`));
	await expect(runsList(page).getByRole('listitem')).toHaveCount(2);
	await expect(page.getByRole('button', { name: 'Run model', exact: true })).toBeEnabled();
	expect(posts).toBe(1);
});

test('Back on Compare runs drops a project picked for a card that had no run to choose', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Compare back after pick');
	const first = await createRun(page.request, project.id, 'Baseline');
	const second = await createRun(page.request, project.id, 'Second');
	const empty = await createProject(page.request, 'Compare empty project');

	await page.goto(`/compare?a=${project.id}:${first}&b=${project.id}:${second}`);
	await expect(runSelect(page, 'What-if 1')).toHaveValue(second);
	// A step in history: what-if 1 becomes the baseline's run.
	await runSelect(page, 'What-if 1').selectOption(first);
	await expect(page).toHaveURL(new RegExp(`b=${project.id}%3A${first}`));

	// What-if 1 picks a project with no runs: the card waits, the URL unchanged.
	const whatIfProject = runCard(page, 'What-if 1').getByRole('combobox', { name: 'Project' });
	await whatIfProject.selectOption(empty.id);
	await expect(runSelect(page, 'What-if 1')).toBeDisabled();
	await expect(runSelect(page, 'What-if 1').getByRole('option', { name: 'This project has no runs' })).toBeAttached();

	// Back to the first pair: the card names the URL's project and run, not the project left waiting.
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`b=${project.id}%3A${second}`));
	await expect(whatIfProject).toHaveValue(project.id);
	await expect(runSelect(page, 'What-if 1')).toBeEnabled();
	await expect(runSelect(page, 'What-if 1')).toHaveValue(second);
});
