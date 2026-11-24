// The live-catchment picker and the paused notice (issue #641 § Downgrade or
// lapse; 341, 345; docs/billing.md § Choosing the catchment to keep, docs/ui.md
// § Plan and usage and § The header's notices). Pausing needs billing enforced
// and a 14-day grace, which e2e can't reach, so the API is answered here with
// page.route: the Plan page reads an account on Free past its one live
// catchment after a plan ended, lists the two, and Keep live on the paused one
// asks through the app's confirm dialog, then shows the list the API answers;
// the workspace of a paused catchment says so in an information note that
// links to the Plan page. The DB tests (backend billing/keepPicker.db.test.ts)
// cover the real pause moving.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject } from '../support/api.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { expect, test } from '../support/fixtures.ts';

const C = '00000000-0000-4000-8000-00000000000c';
const A = '00000000-0000-4000-8000-00000000000a';
const list = (keptA: boolean) => ({
	freeLimit: 1,
	overFreeSince: '2026-11-01T08:00:00.000Z',
	pausesFrom: '2026-11-15T08:00:00.000Z',
	catchments: keptA
		? [
				{ id: A, name: 'Catchment A', chosen: true, staysLive: true, pausedAt: null },
				{ id: C, name: 'Catchment C', chosen: false, staysLive: false, pausedAt: '2026-11-24T10:00:00.000Z' }
			]
		: [
				{ id: C, name: 'Catchment C', chosen: false, staysLive: true, pausedAt: null },
				{ id: A, name: 'Catchment A', chosen: false, staysLive: false, pausedAt: '2026-11-15T08:05:00.000Z' }
			]
});

test('past Free’s live catchment after a plan ended, the owner keeps another one live', async ({ page, owner }) => {
	void owner;
	// The real plan, on Free, two live catchments of one.
	await page.route(`${API_URL}/account/plan`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as { usage: Record<string, unknown> };
		await route.fulfill({ response: res, json: { ...body, subscription: null, enforced: true, usage: { ...body.usage, liveCatchments: { used: 2, limit: 1 } } } });
	});
	await page.route(`${API_URL}/account/plan/live-catchments`, (route) => route.fulfill({ json: list(false) }));
	let kept: unknown = null;
	await page.route(`${API_URL}/account/plan/keep`, (route) => {
		kept = route.request().postDataJSON();
		return route.fulfill({ json: list(true) });
	});

	await page.goto('/account/plan');
	const card = page.getByRole('region', { name: 'Live catchments' });
	await expect(card.locator('[data-keep-intro]')).toHaveText(
		/^The plan for your account has ended, so it is on Free, which keeps 1 catchment live\. On the others, feeds, alerts and automatic runs are paused\. Nothing is lost/
	);
	await expect(card.locator(`[data-keep-row="${C}"] [data-keep-state]`)).toHaveText('Stays live');
	await expect(card.locator(`[data-keep-row="${A}"] [data-keep-state]`)).toHaveText(/^Paused since /);
	// Only the paused one has the button.
	const keep = card.getByRole('button', { name: 'Keep live: Catchment A' });
	await expect(card.getByRole('button', { name: /Keep live/ })).toHaveCount(1);
	await expectNoViolations(page);

	// Cancel changes nothing.
	await keep.click();
	await expect(confirmBox(page)).toContainText('Keep Catchment A live?');
	await answerConfirm(page, false);
	expect(kept).toBeNull();

	await keep.click();
	await answerConfirm(page, true, 'Catchment A keeps its feeds, alerts and automatic runs in place of Catchment C.');
	expect(kept).toEqual({ projectId: A });
	await expect(card.getByRole('status')).toHaveText('Catchment A stays live.');
	await expect(card.locator(`[data-keep-row="${A}"] [data-keep-state]`)).toHaveText('Stays live (your choice)');
	await expect(card.locator(`[data-keep-row="${C}"] [data-keep-state]`)).toHaveText(/^Paused since /);
	await expect(card.getByRole('button', { name: 'Keep live: Catchment C' })).toBeVisible();

	// On a phone the card stays usable.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(card.getByRole('button', { name: 'Keep live: Catchment C' })).toBeVisible();
	await expectNoViolations(page);
});

test('within Free’s live catchments the Plan page shows no picker', async ({ page, owner }) => {
	void owner;
	await page.goto('/account/plan');
	await expect(page.getByRole('region', { name: 'Usage in', exact: false })).toBeVisible();
	await expect(page.locator('[data-keep-live]')).toHaveCount(0);
});

test('a paused catchment’s workspace says so, and links to the Plan page', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Paused catchment');
	await page.route(`${API_URL}/projects/${project.id}`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as { project: Record<string, unknown> };
		await route.fulfill({ response: res, json: { project: { ...body.project, planPausedAt: '2026-11-24T10:00:00.000Z' } } });
	});
	await page.goto(`/projects/${project.id}`);
	const note = page.getByTestId('plan-paused');
	await expect(note).toContainText('Feeds, alerts and automatic runs are paused here since');
	await expect(note).toContainText('Nothing is lost');
	const link = note.getByRole('link', { name: 'Plan and usage' });
	await link.click();
	await expect(page).toHaveURL(/\/account\/plan$/);
});

test('in a reverse trial’s last 3 days the workspace says when it ends, and links Upgrade to the Plan page', async ({ page, owner }) => {
	void owner;
	// REVERSE_TRIAL is off in e2e: the project is answered with the trial end only its account's owner gets (349).
	const project = await createProject(page.request, 'Trial catchment');
	const trialEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
	await page.route(`${API_URL}/projects/${project.id}`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as { project: Record<string, unknown> };
		await route.fulfill({ response: res, json: { project: { ...body.project, planTrialEnd: trialEnd } } });
	});
	await page.goto(`/projects/${project.id}`);
	const note = page.getByTestId('plan-trial-ending');
	await expect(note).toContainText('Your Pro trial ends on');
	await expect(note).toContainText('nothing is charged, nothing is deleted');
	await expectNoViolations(page);
	await note.getByRole('link', { name: 'Upgrade' }).click();
	await expect(page).toHaveURL(/\/account\/plan$/);
});

test('with no trial the workspace shows no trial notice', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'No trial');
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(page.getByTestId('plan-trial-ending')).toHaveCount(0);
});
