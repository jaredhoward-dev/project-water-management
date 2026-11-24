// Changing a Team's seats behind the mock provider (issue #641 Phase 5,
// docs/billing.md § Changing a Team's seats, docs/ui.md § Plan and usage). A
// team buys Team at the 3 included seats through the mock checkout; the plan
// page's Change seats control then asks for 5: a confirm step says the
// change, Cancel leaves it, Confirm posts POST /teams/:id/plan/seats, whose
// mock answer is a signed customer.subscription.updated through the real
// webhook, so the plan card says 5 seats on the re-read.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

test('a Team at the included seats changes to 5 through the confirm step', async ({ page, owner }) => {
	void owner;
	const res = await page.context().request.post(`${API_URL}/teams`, { data: { name: 'Seat change Team' } });
	expect(res.status()).toBe(201);
	const { team } = (await res.json()) as { team: { id: string } };
	await page.goto(`/teams/${team.id}/plan`);
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	// No subscription yet: no Change seats.
	await expect(plan.locator('[data-action="upgrade-month"]')).toBeVisible();
	await expect(page.locator('[data-seat-change]')).toHaveCount(0);

	await plan.locator('[data-action="upgrade-month"]').click();
	await expect(page).toHaveURL(new RegExp(`^${API_URL}/billing/mock/checkout\\?t=`));
	await page.getByRole('button', { name: 'Pays' }).click();
	await expect(page).toHaveURL(new RegExp(`/teams/${team.id}/plan$`));
	await expect(plan.locator('[data-subscription-seats]')).toHaveText('3 editor seats (all included)');

	const box = page.getByRole('region', { name: 'Change seats' });
	const field = box.getByRole('spinbutton', { name: 'Editor seats' });
	const change = box.getByRole('button', { name: 'Change seats' });
	await expect(field).toHaveValue('3');
	// The current count changes nothing: the button is aria-disabled (Playwright won't click it) and no confirm step shows.
	await expect(change).toHaveAttribute('aria-disabled', 'true');
	await expect(box.locator('[data-seat-change-confirm]')).toHaveCount(0);

	// Under the included seats: the field says so.
	await field.fill('2');
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	await expect(change).toHaveAttribute('aria-disabled', 'true');

	await field.fill('5');
	await expect(change).toHaveAttribute('aria-disabled', 'false');
	await change.click();
	const confirm = box.locator('[data-seat-change-confirm]');
	await expect(confirm).toContainText('From 3 to 5 editor seats');
	await expect(confirm).toContainText('prorated on the next invoice');
	await expectNoViolations(page);

	// Cancel leaves it; nothing changes.
	await confirm.getByRole('button', { name: 'Cancel' }).click();
	await expect(confirm).toHaveCount(0);
	await expect(plan.locator('[data-subscription-seats]')).toHaveText('3 editor seats (all included)');

	await change.click();
	await box.getByRole('button', { name: 'Confirm the change' }).click();
	await expect(box.locator('[data-seat-change-done]')).toHaveText('The team now has 5 editor seats.');
	await expect(box.locator('[data-seat-change-done]')).toHaveAttribute('role', 'status');
	await expect(plan.locator('[data-subscription-seats]')).toHaveText('5 editor seats (3 included, 2 extra)');
	await expect(field).toHaveValue('5');
	await expect(change).toHaveAttribute('aria-disabled', 'true');
	await expectNoViolations(page);
});
