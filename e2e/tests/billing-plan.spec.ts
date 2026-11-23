// Plan and usage (issue #641 Phase 1, docs/ui.md § Plan and usage): your own
// account's plan from the account page, a team's for its admins from the team
// page, and the not-found a non-admin gets (a stranger, and a team member who
// isn't an admin); a farmer-only user is sent back to their account page.
// Shadow mode: usage is counted, nothing is refused. Checkout and the portal
// behind the mock provider are billing-checkout.spec.ts.
import { acceptInvites, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

test('your plan and usage, from the account page', async ({ page, owner }) => {
	void owner;
	await page.goto('/account');
	await page.getByRole('region', { name: 'Your data' }).getByRole('link', { name: 'Plan and usage' }).click();
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
	// Free includes no evidence packs: said, not drawn as "0 of 0".
	await expect(usage.locator('[data-usage="packsIssued"] [data-figures]')).toHaveText('Not included in Free');
	await expect(usage.getByRole('meter', { name: /^Evidence packs/ })).toHaveCount(0);
	// The assistant in dollars against Free's $1.00 a month, by the UTC month.
	await expect(usage.locator('[data-usage="assistantCost"] [data-figures]')).toHaveText('$0.00 of $1.00');
	await expect(usage.getByRole('meter', { name: /^Assistant use in / })).toBeVisible();
	await expect(usage.locator('[data-usage="assistantCost"]')).toContainText('UTC month');

	// Phase 3: the e2e API runs the mock provider (the code default), so Free offers Upgrade to Pro and nothing to
	// manage yet (billing-checkout.spec.ts follows the buttons; with BILLING_PROVIDER=manual there are none).
	await expect(plan.getByRole('button', { name: 'Upgrade to Pro, monthly' })).toBeVisible();
	await expect(plan.getByRole('button', { name: 'Manage billing' })).toHaveCount(0);
	await expectNoViolations(page);

	await resizeTo(page, { width: 360, height: 780 });
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
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

test('a team member who isn’t an admin gets no link and the not-found', async ({ page, owner, signIn }) => {
	void owner;
	const res = await page.context().request.post(`${API_URL}/teams`, { data: { name: 'Plan Members' } });
	expect(res.status()).toBe(201);
	const { team } = (await res.json()) as { team: { id: string } };
	const member = await signIn('Plan member');
	expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: member.user.email, role: 'member' } })).status()).toBe(201);
	expect(await acceptInvites(member.user.email, team.id)).toBe(1);

	const p = member.page;
	await p.goto(`/teams/${team.id}`);
	await expect(p.getByRole('heading', { level: 1, name: 'Plan Members' })).toBeVisible();
	await expect(p.getByRole('link', { name: 'Plan and usage' })).toHaveCount(0);

	await p.goto(`/teams/${team.id}/plan`);
	await expect(p.locator('[data-not-found]')).toContainText("This team doesn't exist or you're not one of its admins.");
	await expect(p.getByRole('region', { name: 'Plan', exact: true })).toHaveCount(0);
});

test('a farmer-only user is sent back to their account page, with no plan link there', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Plan farm catchment');
	const farm = project.model.nodes.find((n) => n.name === 'Lower farm')!;
	const farmer = await signIn('Plan farmer');
	const add = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [farm.id] } });
	expect(add.status(), await add.text()).toBe(201);
	expect(await acceptInvites(farmer.user.email, project.id)).toBe(1);

	const p = farmer.page;
	await p.goto('/account/plan');
	await expect(p).toHaveURL(/\/account$/);
	await expect(p.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
	await expect(p.locator('.farm-header')).toBeVisible();
	// The Your data panel is up (where the link sits for everyone else), with no link to the plan.
	await expect(p.getByRole('button', { name: 'Download my data' })).toBeVisible();
	await expect(p.getByRole('link', { name: 'Plan and usage' })).toHaveCount(0);
	await expect(p.getByRole('region', { name: /^Usage in / })).toHaveCount(0);
});
