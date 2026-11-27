// Selection and URL state on Runs & results and Compare runs when the page moves under a pick still out: a run
// shown from the cache while another run's results are loading, a run that finishes after its tab was left, and a
// compare card's project pick left waiting when Back changes the pair, the comparison marked as of the runs before
// while a card waits on a project with no runs, and the pick after the run on screen is deleted (issue #924); a run
// still going when its tab is opened again, and one that fails while another tab is open (issue #923).
import { answerConfirm } from '../support/confirm.ts';
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

test('a run from Runs & results that fails while another tab is open says so on the notice line until dismissed', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Run fails elsewhere');
	await createRun(page.request, project.id, 'Baseline');
	await openRuns(page, project.id);

	// Hold the run, then fail it once the person is on another tab (issue #923).
	let release = () => {};
	const held = new Promise<void>((r) => (release = r));
	const listPath = `/projects/${project.id}/runs`;
	await page.route(
		(url) => url.pathname.endsWith(listPath),
		async (route) => {
			if (route.request().method() !== 'POST') return route.fallback();
			await held;
			return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The engine stopped' }) });
		}
	);
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('button', { name: 'Running model…' })).toBeDisabled();
	await sections(page).getByRole('link', { name: 'Network' }).click();
	await expect(page).toHaveURL(/\?tab=network$/);
	const failed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(listPath) && r.request().method() === 'POST');
	release();
	await failed;

	// The page says it, on the tab the person is on, and the run's project is free to run again.
	const notice = page.getByTestId('tab-run-failed');
	await expect(notice).toHaveText(/The run from Runs & results failed: The engine stopped/);
	await expect(notice).toHaveAttribute('role', 'alert');
	await sections(page).getByRole('link', { name: 'Runs & results' }).click();
	await expect(page.getByRole('button', { name: 'Run model', exact: true })).toBeEnabled();
	await expect(notice).toBeVisible();

	// Dismiss acknowledges it.
	await notice.getByRole('button', { name: 'Dismiss' }).click();
	await expect(notice).toHaveCount(0);
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
	await expect.poll(() => new URL(page.url()).searchParams.get('b')).toBe(`${project.id}:${first}`);

	// What-if 1 picks a project with no runs: the card waits, the URL unchanged.
	const whatIfProject = runCard(page, 'What-if 1').getByRole('combobox', { name: 'Project' });
	await whatIfProject.selectOption(empty.id);
	await expect(runSelect(page, 'What-if 1')).toBeDisabled();
	await expect(runSelect(page, 'What-if 1').getByRole('option', { name: 'This project has no runs' })).toBeAttached();

	// Back to the first pair: the card names the URL's project and run, not the project left waiting. (Read
	// decoded: the first address has a raw `:`, the ones the page writes `%3A`.)
	await page.goBack();
	await expect.poll(() => new URL(page.url()).searchParams.get('b')).toBe(`${project.id}:${second}`);
	await expect(whatIfProject).toHaveValue(project.id);
	await expect(runSelect(page, 'What-if 1')).toBeEnabled();
	await expect(runSelect(page, 'What-if 1')).toHaveValue(second);
});

test('while a card waits on a project with no runs, the comparison says it is still of the runs before', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Compare stale pair');
	const first = await createRun(page.request, project.id, 'Baseline');
	const second = await createRun(page.request, project.id, 'Second');
	const empty = await createProject(page.request, 'Compare stale empty');

	await page.goto(`/compare?a=${project.id}:${first}&b=${project.id}:${second}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Full comparison' })).toBeVisible();
	await expect(page.getByTestId('compare-stale')).toHaveCount(0);

	await runCard(page, 'What-if 1').getByRole('combobox', { name: 'Project' }).selectOption(empty.id);
	await expect(runSelect(page, 'What-if 1')).toBeDisabled();
	// The URL keeps the pair, and the comparison below is marked as of it, not of the card's empty project.
	await expect.poll(() => new URL(page.url()).searchParams.get('b')).toBe(`${project.id}:${second}`);
	await expect(page.getByTestId('compare-stale')).toHaveText(
		"What-if 1's project, Compare stale empty, has no runs, so the comparison below is still of the runs chosen before. Pick a project with runs, or go Back."
	);
	await expect(runCard(page, 'What-if 1').getByText('No run chosen')).toBeVisible();
	await expect(runCard(page, 'What-if 1').getByTestId('what-if-change')).toHaveCount(0);

	// Back to a project with runs: a run is picked and the note goes.
	await runCard(page, 'What-if 1').getByRole('combobox', { name: 'Project' }).selectOption(project.id);
	await expect(runSelect(page, 'What-if 1')).toBeEnabled();
	await expect(page.getByTestId('compare-stale')).toHaveCount(0);
});

test('the standalone page’s Back to runs opens the Runs tab on the run being looked at', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Compare back keeps run');
	const first = await createRun(page.request, project.id, 'Baseline');
	await createRun(page.request, project.id, 'Second');
	const third = await createRun(page.request, project.id, 'Third');

	// What-if 1 is not the newest run, so the Runs tab's own default would show another.
	await page.goto(`/compare?a=${project.id}:${third}&b=${project.id}:${first}`);
	const back = page.getByRole('link', { name: 'Back to runs' });
	await expect(back).toHaveAttribute('href', `/projects/${project.id}?tab=runs&run=${first}`);
	await back.click();
	await expect(page).toHaveURL(new RegExp(`tab=runs&run=${first}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
});

test('deleting the run on screen shows the run first load would', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Runs delete default');
	await createRun(page.request, project.id, 'Baseline');
	const second = await createRun(page.request, project.id, 'Second');
	const third = await createRun(page.request, project.id, 'Third');

	await openRuns(page, project.id);
	await expect(page.getByRole('heading', { level: 2, name: 'Third' })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`run=${third}`));

	await runsList(page).getByRole('button', { name: 'Delete run Third' }).click();
	await answerConfirm(page, true);
	// An editor's default (runList.ts defaultRunId): the newest run left.
	await expect(page).toHaveURL(new RegExp(`run=${second}`));
	await expect(page.getByRole('heading', { level: 2, name: 'Second' })).toBeVisible();
	await expect(runsList(page).getByRole('button', { name: 'Delete run Third' })).toHaveCount(0);
});
