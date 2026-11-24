// Checkout and the portal behind the mock provider (issue #641 Phase 3,
// docs/billing.md § Checkout and portal, docs/ui.md § Plan and usage). The
// e2e API runs BILLING_PROVIDER=mock (the code default), so Upgrade opens the
// mock's own checkout page on the API, whose "pays" posts signed events to
// the real webhook route; nothing leaves the machine. Declines keeps the
// person on the page, cancels comes back with nothing charged, pays comes
// back on Pro with Manage billing, and the mock portal cancels at the period
// end. Then the edges: Back from the mock's page leaves the buttons usable, a
// refused request says the API's words inline and keeps the focus, and a
// payment the provider hasn't confirmed yet is waited for. A team buys Team
// with 5 editor seats: the seat field prices the buttons, and the
// subscription comes back with 5 seats, which the plan card then says. The
// seat field keeps what is typed (blank, 1e1, 4,5 stay, with the message).
// The seat field starts at the team's editors when they pass the included
// seats, saying how many there are, and a paid subscription says its total
// from its interval and seats (332).
import { request as apiRequest } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { acceptInvites, register } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// The buttons carry their prices from GET /billing/plans (migration 323's Pro: R 899.00 a month, R 8 990.00 a year).
const MONTHLY = /^Upgrade to Pro, monthly \(R.899\.00 a month\)$/;
const YEARLY = /^Upgrade to Pro, yearly \(R.8.990\.00 a year\)$/;

test('upgrade through the mock checkout, then cancel from the mock portal', async ({ page, owner }) => {
	void owner;
	await page.goto('/account/plan');
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	await expect(plan.locator('[data-plan-name]')).toHaveText('Free');
	await expect(plan.getByRole('button', { name: YEARLY })).toBeVisible();
	// Beside buttons that can charge, the note says only that limits aren't enforced.
	await expect(plan.locator('[data-shadow]')).toContainText('Limits aren’t enforced yet.');
	await expect(plan.locator('[data-shadow]')).not.toContainText('charged');
	await expectNoViolations(page);

	// The mock's page lives on the API, never on the site.
	await plan.getByRole('button', { name: MONTHLY }).click();
	await expect(page).toHaveURL(new RegExp(`^${API_URL}/billing/mock/checkout\\?t=`));
	await expect(page.getByRole('heading', { level: 1, name: 'Subscribe to Pro' })).toBeVisible();
	await expect(page.locator('[data-mock-price]')).toHaveText('ZAR 899.00 a month.');

	// Declines: still here, saying so.
	await page.getByRole('button', { name: 'Declines' }).click();
	await expect(page.getByRole('alert')).toContainText('Your card was declined (simulated).');

	// Cancels: back on the plan page, nothing charged.
	await page.getByRole('button', { name: 'Cancels' }).click();
	await expect(page.locator('[data-checkout-notice="cancelled"]')).toHaveText('Checkout was cancelled. Nothing was charged.');
	// Said through the live region, and taken off the address so a reload doesn't say it again; the notice stays.
	await expect(page.locator('[data-checkout-status]')).toHaveAttribute('role', 'status');
	await expect(page).toHaveURL(/\/account\/plan$/);
	await expect(page.locator('[data-checkout-notice="cancelled"]')).toBeVisible();
	await expect(plan.locator('[data-plan-name]')).toHaveText('Free');

	// Pays: back on Pro, with Manage billing in Upgrade's place.
	await plan.getByRole('button', { name: MONTHLY }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Subscribe to Pro' })).toBeVisible();
	await page.getByRole('button', { name: 'Pays' }).click();
	// The mock posts its webhook before sending the person back, so the plan is already Pro: nothing to wait for.
	await expect(page.locator('[data-checkout-notice="done"]')).toHaveText('Thank you: the payment went through.');
	await expect(page.locator('[data-checkout-notice="done"]')).toHaveAttribute('data-confirm', 'confirmed');
	await expect(page).toHaveURL(/\/account\/plan$/);
	await expect(plan.locator('[data-plan-name]')).toHaveText('Pro');
	await expect(plan.locator('[data-subscription="active"]')).toContainText('Renews');
	await expect(plan.locator('[data-subscription-total]')).toHaveText(/^R.899\.00 a month$/);
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

test('a team buys Team with 5 editor seats: the field prices the buttons, the mock sells them, the plan holds them', async ({ page, owner }) => {
	void owner;
	const res = await page.context().request.post(`${API_URL}/teams`, { data: { name: 'Seats Team' } });
	expect(res.status()).toBe(201);
	const { team } = (await res.json()) as { team: { id: string } };
	await page.goto(`/teams/${team.id}/plan`);
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	const seats = plan.getByRole('spinbutton', { name: 'Editor seats' });
	await expect(seats).toHaveValue('3');
	// One editor (the admin who made it): the field starts at the 3 included seats, and says so.
	await expect(plan.locator('[data-seats-editors]')).toHaveText('This team has 1 editor.');
	await expect(seats).toHaveAccessibleDescription(/3 editor seats included; each extra one is R.499\.00 a month or R.4.990\.00 a year\. Up to 50\./);

	// Under the included seats: said under the field, the buttons show no price, and they do nothing.
	const seatsError = plan.locator('#checkout-seats-err');
	await seats.fill('2');
	await expect(seats).toHaveAttribute('aria-invalid', 'true');
	await expect(seatsError).toHaveText('Choose a whole number of seats from 3 to 50.');
	await expect(seats).toHaveAccessibleDescription(/Choose a whole number of seats from 3 to 50\./);
	await expect(plan.locator('[data-action="upgrade-month"]')).toHaveAccessibleName('Upgrade to Team, monthly');
	await expect(plan.locator('[data-action="upgrade-year"]')).toHaveAccessibleName('Upgrade to Team, yearly');
	await expectNoViolations(page);
	await expect(plan.locator('[data-action="upgrade-month"]')).toHaveAttribute('aria-disabled', 'true');
	await plan.locator('[data-action="upgrade-month"]').click();
	await expect(page).toHaveURL(new RegExp(`/teams/${team.id}/plan$`));

	// Cleared, the field stays empty with its message (no default put back); an exponent or a decimal comma is refused, not read.
	await seats.fill('');
	await expect(seats).toHaveValue('');
	await expect(seatsError).toBeVisible();
	for (const bad of ['1e1', '4,5', '4.5']) {
		await seats.fill(bad);
		await expect(seats, bad).toHaveValue(bad);
		await expect(seats, bad).toHaveAttribute('aria-invalid', 'true');
	}

	// Backspace over the 3 and type 5: exactly 5, not 35.
	await seats.fill('3');
	await expect(seats).not.toHaveAttribute('aria-invalid', 'true');
	await seats.press('End');
	await seats.press('Backspace');
	await expect(seats).toHaveValue('');
	await seats.pressSequentially('5');
	await expect(seats).toHaveValue('5');

	// The arrow keys step it by one.
	await seats.press('ArrowUp');
	await expect(seats).toHaveValue('6');
	await seats.press('ArrowDown');
	await expect(seats).toHaveValue('5');

	// 5 seats: R 2 499 + 2 × R 499 = R 3 497 a month.
	await expect(seats).not.toHaveAttribute('aria-invalid', 'true');
	await expect(seatsError).toHaveCount(0);
	await expect(plan.getByRole('button', { name: /^Upgrade to Team, yearly \(R.34.970\.00 a year for 5 editor seats\)$/ })).toBeVisible();
	await expectNoViolations(page);
	await plan.getByRole('button', { name: /^Upgrade to Team, monthly \(R.3.497\.00 a month for 5 editor seats\)$/ }).click();
	await expect(page).toHaveURL(new RegExp(`^${API_URL}/billing/mock/checkout\\?t=`));
	await expect(page.locator('[data-mock-price]')).toHaveText('ZAR 3497.00 a month.');
	await expect(page.locator('[data-mock-seats]')).toHaveText('5 editor seats: 3 included and 2 extra at ZAR 499.00 each.');
	await page.getByRole('button', { name: 'Pays' }).click();
	await expect(page).toHaveURL(new RegExp(`/teams/${team.id}/plan$`));
	await expect(plan.locator('[data-plan-name]')).toHaveText('Team');
	await expect(plan.locator('[data-subscription-seats]')).toHaveText('5 editor seats (3 included, 2 extra)');
	await expect(plan.locator('[data-subscription-total]')).toHaveText(/^R.3.497\.00 a month for 5 editor seats$/);
	const after = await page.context().request.get(`${API_URL}/teams/${team.id}/plan`);
	expect(((await after.json()) as { subscription: { seats: number; interval: string } }).subscription).toMatchObject({ seats: 5, interval: 'month' });
});

test('a team with more editors than the included seats: the seat field starts at its editors, and a yearly Team says its total', async ({ page, owner }) => {
	void owner;
	const res = await page.context().request.post(`${API_URL}/teams`, { data: { name: 'Editors Team' } });
	expect(res.status()).toBe(201);
	const { team } = (await res.json()) as { team: { id: string } };
	// Three members (editors) and a viewer, who holds no seat: with the admin, 4 editors.
	const others = await apiRequest.newContext();
	try {
		for (const [name, role] of [
			['Seat member one', 'member'],
			['Seat member two', 'member'],
			['Seat member three', 'member'],
			['Seat viewer', 'viewer']
		] as const) {
			const u = await register(others, name);
			expect((await page.request.post(`${API_URL}/teams/${team.id}/members`, { data: { email: u.email, role } })).status()).toBe(201);
			expect(await acceptInvites(u.email, team.id)).toBe(1);
		}
	} finally {
		await others.dispose();
	}

	await page.goto(`/teams/${team.id}/plan`);
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	const seats = plan.getByRole('spinbutton', { name: 'Editor seats' });
	await expect(seats).toHaveValue('4');
	await expect(plan.locator('[data-seats-editors]')).toHaveText('This team has 4 editors.');
	await expect(seats).toHaveAccessibleDescription(/^This team has 4 editors\. 3 editor seats included/);
	await expect(plan.getByRole('button', { name: /^Upgrade to Team, yearly \(R.29.980\.00 a year for 4 editor seats\)$/ })).toBeVisible();
	await expectNoViolations(page);

	await plan.getByRole('button', { name: /^Upgrade to Team, yearly/ }).click();
	await expect(page.locator('[data-mock-seats]')).toHaveText('4 editor seats: 3 included and 1 extra at ZAR 4990.00 each.');
	await page.getByRole('button', { name: 'Pays' }).click();
	await expect(page).toHaveURL(new RegExp(`/teams/${team.id}/plan$`));
	// R 24 990 + 1 × R 4 990 = R 29 980 a year.
	await expect(plan.locator('[data-subscription-total]')).toHaveText(/^R.29.980\.00 a year for 4 editor seats$/);
});

test('Back from the mock checkout leaves the Upgrade buttons usable', async ({ page, owner }) => {
	void owner;
	await page.goto('/account/plan');
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	await plan.getByRole('button', { name: MONTHLY }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Subscribe to Pro' })).toBeVisible();

	await page.goBack();
	await expect(page).toHaveURL(/\/account\/plan$/);
	// A page restored from the back-forward cache comes back with the press that left still marked busy; pageshow frees it.
	for (const name of [MONTHLY, YEARLY]) await expect(plan.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'false');
	await expect(plan).not.toHaveAttribute('aria-busy', 'true');
	await plan.getByRole('button', { name: YEARLY }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Subscribe to Pro' })).toBeVisible();
});

test('a refused checkout says the API’s words inline and keeps the focus on the button', async ({ page, owner }) => {
	void owner;
	// The billing codes are machine-only, so the page shows the API's English message, not a generic line.
	await page.route(new RegExp(`^${API_URL}/account/plan/checkout$`), (route) =>
		route.request().method() === 'POST'
			? route.fulfill({
					status: 409,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'another checkout for this account started at the same time; try again', code: 'billing_checkout_race' })
				})
			: route.fallback()
	);
	await page.goto('/account/plan');
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	const monthly = plan.getByRole('button', { name: MONTHLY });
	await monthly.focus();
	await page.keyboard.press('Enter');

	await expect(plan.locator('[data-billing-error]')).toHaveText(
		'Couldn’t open billing: another checkout for this account started at the same time; try again'
	);
	await expect(plan.getByRole('alert')).not.toContainText('clashes');
	// aria-disabled, never disabled, while it asks: the focus stays where the person pressed.
	await expect(monthly).toBeFocused();
	await expect(monthly).toHaveAttribute('aria-disabled', 'false');
	await expect(page).toHaveURL(/\/account\/plan$/);
	await expectNoViolations(page);
});

test('back from a payment the provider hasn’t confirmed yet, the page waits for it', async ({ page, owner }) => {
	void owner;
	// The first read is the real Free plan; the next answers as the webhook would have left it: Pro, active.
	let reads = 0;
	await page.route(new RegExp(`^${API_URL}/account/plan$`), async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		reads += 1;
		const res = await route.fetch();
		if (reads === 1) return route.fulfill({ response: res });
		const body = (await res.json()) as Record<string, unknown> & { plan: Record<string, unknown> };
		const subscription = { status: 'active', seats: 1, periodStart: null, periodEnd: null, trialEnd: null, cancelAtPeriodEnd: false };
		return route.fulfill({ response: res, json: { ...body, plan: { ...body.plan, code: 'pro', name: 'Pro' }, subscription } });
	});
	await page.goto('/account/plan?checkout=done');
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	const notice = page.locator('[data-checkout-notice="done"]');
	await expect(notice).toHaveText('Thank you: the payment went through. Waiting for the payment provider to confirm…');
	await expect(notice).toHaveAttribute('data-confirm', 'confirmed');
	await expect(notice).toHaveText('Thank you: the payment went through.');
	await expect(plan.locator('[data-plan-name]')).toHaveText('Pro');
	await expect(plan.getByRole('button', { name: 'Manage billing' })).toBeVisible();
	await expect(page).toHaveURL(/\/account\/plan$/);
	expect(reads).toBe(2);
});
