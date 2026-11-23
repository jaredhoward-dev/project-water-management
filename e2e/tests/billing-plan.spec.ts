// Plan and usage (issue #641 Phase 1, docs/ui.md § Plan and usage): your own
// account's plan from the account page, a team's for its admins from the team
// page, and the not-found a non-admin gets. Shadow mode: usage is counted,
// nothing is charged, so the page offers no upgrade or checkout.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

test('your plan and usage, from the account page', async ({ page, owner }) => {
	void owner;
	await page.goto('/account');
	await page.getByRole('link', { name: 'Plan and usage' }).click();
	await expect(page).toHaveURL(/\/account\/plan$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Plan and usage' })).toBeVisible();

	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	await expect(plan.locator('[data-plan-name]')).toHaveText('Free');
	await expect(plan.locator('[data-price]')).toHaveText('No charge');
	await expect(plan.locator('[data-shadow]')).toContainText('Plans aren’t charged yet.');

	// Free counts catchments without a limit; its reports have one, drawn as a bar.
	const usage = page.getByRole('region', { name: /^Usage in / });
	await expect(usage.locator('[data-usage="catchments"] [data-status]')).toHaveText('Unlimited');
	await expect(usage.locator('[data-usage="reports"] [data-figures]')).toHaveText('0 of 5');
	await expect(usage.getByRole('meter', { name: /^Reports in / })).toBeVisible();

	// No way to pay in Phase 1.
	await expect(page.getByRole('button', { name: /upgrade|checkout|subscribe/i })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /upgrade|checkout|subscribe/i })).toHaveCount(0);
	await expectNoViolations(page);

	await resizeTo(page, { width: 360, height: 780 });
	await expectNoSidewaysScroll(page);
});

test('a team’s plan is for its admins', async ({ page, owner, signIn }) => {
	void owner;
	const res = await page.context().request.post(`${API_URL}/teams`, { data: { name: 'Plan Team' } });
	expect(res.status()).toBe(201);
	const { team } = (await res.json()) as { team: { id: string } };

	await page.goto(`/teams/${team.id}`);
	await page.getByRole('link', { name: 'Plan and usage' }).click();
	await expect(page).toHaveURL(new RegExp(`/teams/${team.id}/plan$`));
	await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Plan Team' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Plan', exact: true }).locator('[data-plan-name]')).toBeVisible();
	await expectNoViolations(page);

	// Someone who isn't its admin gets the team's not-found, and no plan.
	const other = await signIn('Not an admin');
	await other.page.goto(`/teams/${team.id}/plan`);
	await expect(other.page.locator('[data-not-found]')).toContainText("This team doesn't exist or you're not one of its admins.");
	await expect(other.page.getByRole('region', { name: 'Plan', exact: true })).toHaveCount(0);
});
