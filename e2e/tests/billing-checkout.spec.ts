// Checkout and the portal behind the mock provider (issue #641 Phase 3,
// docs/billing.md § Checkout and portal, docs/ui.md § Plan and usage). The
// e2e API runs BILLING_PROVIDER=mock (the code default), so Upgrade opens the
// mock's own checkout page on the API, whose "pays" posts signed events to
// the real webhook route; nothing leaves the machine. Declines keeps the
// person on the page, cancels comes back with nothing charged, pays comes
// back on Pro with Manage billing, and the mock portal cancels at the period
// end.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expect, test } from '../support/fixtures.ts';

test('upgrade through the mock checkout, then cancel from the mock portal', async ({ page, owner }) => {
	void owner;
	await page.goto('/account/plan');
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	await expect(plan.locator('[data-plan-name]')).toHaveText('Free');
	await expect(plan.getByRole('button', { name: 'Upgrade to Pro, yearly' })).toBeVisible();
	await expectNoViolations(page);

	// The mock's page lives on the API, never on the site.
	await plan.getByRole('button', { name: 'Upgrade to Pro, monthly' }).click();
	await expect(page).toHaveURL(new RegExp(`^${API_URL}/billing/mock/checkout\\?t=`));
	await expect(page.getByRole('heading', { level: 1, name: 'Subscribe to Pro' })).toBeVisible();
	await expect(page.locator('[data-mock-price]')).toHaveText('ZAR 899.00 a month.');

	// Declines: still here, saying so.
	await page.getByRole('button', { name: 'Declines' }).click();
	await expect(page.getByRole('alert')).toContainText('Your card was declined (simulated).');

	// Cancels: back on the plan page, nothing charged.
	await page.getByRole('button', { name: 'Cancels' }).click();
	await expect(page).toHaveURL(/\/account\/plan\?checkout=cancelled$/);
	await expect(page.locator('[data-checkout-notice="cancelled"]')).toHaveText('Checkout was cancelled. Nothing was charged.');
	await expect(plan.locator('[data-plan-name]')).toHaveText('Free');

	// Pays: back on Pro, with Manage billing in Upgrade's place.
	await plan.getByRole('button', { name: 'Upgrade to Pro, monthly' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Subscribe to Pro' })).toBeVisible();
	await page.getByRole('button', { name: 'Pays' }).click();
	await expect(page).toHaveURL(/\/account\/plan\?checkout=done$/);
	await expect(page.locator('[data-checkout-notice="done"]')).toContainText('the payment went through');
	await expect(plan.locator('[data-plan-name]')).toHaveText('Pro');
	await expect(plan.locator('[data-subscription="active"]')).toContainText('Renews');
	await expect(plan.getByRole('button', { name: /^Upgrade/ })).toHaveCount(0);
	await expectNoViolations(page);

	// The mock portal: cancel at the end of the period, and back.
	await plan.getByRole('button', { name: 'Manage billing' }).click();
	await expect(page).toHaveURL(new RegExp(`^${API_URL}/billing/mock/portal\\?t=`));
	await page.getByRole('button', { name: 'Cancel at the end of the period' }).click();
	await expect(page).toHaveURL(/\/account\/plan$/);
	await expect(plan.locator('[data-plan-name]')).toHaveText('Pro');
	await expect(plan.locator('[data-subscription="active"]')).toContainText('it won\'t renew');
	await expect(plan.getByRole('button', { name: 'Manage billing' })).toBeVisible();
});
