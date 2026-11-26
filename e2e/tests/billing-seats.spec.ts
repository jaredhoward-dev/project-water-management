// Changing a Team's seats behind the mock provider (issue #641 Phase 5,
// docs/billing.md § Changing a Team's seats, docs/ui.md § Plan and usage). A
// team buys Team at the 3 included seats through the mock checkout; the Plan
// card's Change seats then asks for 5: the app's confirm dialog says the
// change and its money, Cancel leaves it, Change seats posts POST
// /teams/:id/plan/seats, whose mock answer is a signed
// customer.subscription.updated through the real webhook, so the plan card
// says 5 seats on the re-read. Also: the field fills when the subscription
// arrives after the page (a checkout's re-read), and a refusal keeps the count.
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { expect, test } from '../support/fixtures.ts';
import type { Page } from '@playwright/test';

/** A new team bought at Team's 3 included seats, monthly, through the mock checkout; back on its plan page. */
async function teamOnTeamPlan(page: Page, name: string): Promise<string> {
	const res = await page.context().request.post(`${API_URL}/teams`, { data: { name } });
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
	return team.id;
}

test('a Team at the included seats changes to 5 through the confirm dialog', async ({ page, owner }) => {
	void owner;
	await teamOnTeamPlan(page, 'Seat change Team');
	const plan = page.getByRole('region', { name: 'Plan', exact: true });

	// Change seats sits inside the Plan card, under the seats line.
	const box = plan.getByRole('region', { name: 'Change seats' });
	const field = box.getByRole('spinbutton', { name: 'Editor seats' });
	const change = box.getByRole('button', { name: 'Change seats' });
	await expect(field).toHaveValue('3');
	await expect(box.locator('[data-seat-change-editors]')).toHaveText(/^This team has \d+ editors?\.$/);
	// The current count changes nothing: the button is aria-disabled (Playwright won't click it).
	await expect(change).toHaveAttribute('aria-disabled', 'true');

	// Under the included seats: the field says so.
	await field.fill('2');
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	await expect(change).toHaveAttribute('aria-disabled', 'true');

	await field.fill('5');
	await expect(change).toHaveAttribute('aria-disabled', 'false');
	await change.click();
	const dialog = confirmBox(page);
	await expect(dialog).toContainText('Change editor seats?');
	// The subscription was bought monthly, so the line says the money: 2 extra seats at R 499.00.
	await expect(dialog).toContainText(/From 3 to 5 editor seats: R.998\.00 more a month\./);
	await expect(dialog).toContainText('prorated on the next invoice');
	await expectNoViolations(page);

	// Cancel leaves it; nothing changes, and the focus is back on the button.
	await answerConfirm(page, false);
	await expect(change).toBeFocused();
	await expect(plan.locator('[data-subscription-seats]')).toHaveText('3 editor seats (all included)');

	await change.click();
	await answerConfirm(page, true, 'From 3 to 5 editor seats');
	await expect(change).toBeFocused();
	const done = box.locator('[data-seat-change-done]');
	await expect(done).toHaveText('The team now has 5 editor seats.');
	await expect(done).toHaveAttribute('role', 'status');
	await expect(done).toHaveAttribute('data-confirm', 'confirmed');
	await expect(plan.locator('[data-subscription-seats]')).toHaveText('5 editor seats (3 included, 2 extra)');
	await expect(field).toHaveValue('5');
	await expect(change).toHaveAttribute('aria-disabled', 'true');
	await expectNoViolations(page);

	// On a phone: the card and its Change seats stay accessible.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(field).toBeVisible();
	await expectNoViolations(page);
});

test('the seat field fills when the subscription arrives after the page (back from checkout)', async ({ page, owner }) => {
	void owner;
	const id = await teamOnTeamPlan(page, 'Late subscription Team');
	// The first read of the plan answers as before the provider's webhook landed; the re-reads see the subscription.
	let reads = 0;
	await page.route(`${API_URL}/teams/${id}/plan`, async (route) => {
		if (route.request().method() !== 'GET' || reads++ > 0) return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as Record<string, unknown>;
		await route.fulfill({ response: res, json: { ...body, subscription: null } });
	});
	await page.goto(`/teams/${id}/plan?checkout=done`);
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	await expect(plan.locator('[data-checkout-notice]')).toHaveAttribute('data-confirm', 'confirmed');
	expect(reads).toBeGreaterThan(1);
	await expect(plan.getByRole('region', { name: 'Change seats' }).getByRole('spinbutton', { name: 'Editor seats' })).toHaveValue('3');
});

test('a refused seat change shows the refusal and keeps the count typed', async ({ page, owner }) => {
	void owner;
	const id = await teamOnTeamPlan(page, 'Refused seats Team');
	await page.route(`${API_URL}/teams/${id}/plan/seats`, (route) =>
		route.fulfill({ status: 409, json: { error: 'A seat change is already in progress for this team.' } })
	);
	const box = page.getByRole('region', { name: 'Plan', exact: true }).getByRole('region', { name: 'Change seats' });
	const field = box.getByRole('spinbutton', { name: 'Editor seats' });
	await field.fill('4');
	await box.getByRole('button', { name: 'Change seats' }).click();
	await answerConfirm(page, true);
	await expect(box.getByRole('alert')).toContainText('Couldn’t change the seats');
	await expect(field).toHaveValue('4');
	await expect(box.locator('[data-seat-change-done]')).toHaveText('');
});

// A team admin raises a member's share of the team's assistant dollars (issue #641, 339; docs/billing.md § Assistant
// dollar caps): Assistant share sits in the Plan card on every team plan; on Free it says it applies on Team, and on
// Team it says the share in the pooled dollars (3 seats × $15 = $45). Through the confirm dialog to 80%.
test('a team admin raises the assistant share through the confirm dialog', async ({ page, owner }) => {
	void owner;
	const res = await page.context().request.post(`${API_URL}/teams`, { data: { name: 'Assistant share Team' } });
	expect(res.status()).toBe(201);
	const { team } = (await res.json()) as { team: { id: string } };
	await page.goto(`/teams/${team.id}/plan`);
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	const freeBox = plan.getByRole('region', { name: 'Assistant share' });
	await expect(freeBox.locator('[data-assistant-share-line]')).toHaveText(
		'One member may use up to 50% of the team’s assistant dollars a month. This applies once the team is on the Team plan.'
	);

	// A second team, bought at Team's 3 included seats.
	await teamOnTeamPlan(page, 'Assistant share Team, paid');
	const box = plan.getByRole('region', { name: 'Assistant share' });
	const field = box.getByRole('spinbutton', { name: 'Most one member may use (%)' });
	const change = box.getByRole('button', { name: 'Change share' });
	await expect(field).toHaveValue('50');
	await expect(box.locator('[data-assistant-share-line]')).toHaveText('One member may use up to 50% of the team’s assistant dollars a month ($22.50 of $45.00).');
	await expect(change).toHaveAttribute('aria-disabled', 'true');

	// Past 100: the field says so.
	await field.fill('101');
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	await expect(change).toHaveAttribute('aria-disabled', 'true');

	await field.fill('80');
	await expect(change).toHaveAttribute('aria-disabled', 'false');
	await change.click();
	await expect(confirmBox(page)).toContainText('Change the assistant share?');
	await expectNoViolations(page);
	await answerConfirm(page, false);
	await expect(change).toBeFocused();
	await expect(box).toHaveAttribute('data-share', '50');

	await change.click();
	await answerConfirm(page, true, 'From 50% to 80%: one member may use up to $36.00 of the team’s $45.00 a month.');
	await expect(box.locator('[data-assistant-share-done]')).toHaveText('Saved: one member may now use up to 80%.');
	await expect(box).toHaveAttribute('data-share', '80');
	await expect(box.locator('[data-assistant-share-line]')).toHaveText('One member may use up to 80% of the team’s assistant dollars a month ($36.00 of $45.00).');
	await expect(change).toHaveAttribute('aria-disabled', 'true');
	await expectNoViolations(page);

	// Read back after a reload: the API kept it.
	await page.reload();
	await expect(plan.getByRole('region', { name: 'Assistant share' }).getByRole('spinbutton')).toHaveValue('80');
});

// 403 (issue #926): a team with more editors than its plan pays for (seats cut in Stripe's portal) sees a note on its
// Plan card saying how many over and what to do. The API's team.overSeats is mocked onto the real plan answer.
test('a team over its paid seats sees the over-seats note on its Plan card', async ({ page, owner }) => {
	void owner;
	const teamId = await teamOnTeamPlan(page, 'Over seats Team');
	await page.route(`${API_URL}/teams/${teamId}/plan`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as { team: Record<string, unknown> };
		body.team = { ...body.team, editorCount: 5, overSeats: { seats: 3, editors: 5, since: '2026-11-20T08:00:00.000Z' } };
		await route.fulfill({ response: res, json: body });
	});
	await page.reload();
	const plan = page.getByRole('region', { name: 'Plan', exact: true });
	const note = plan.locator('[data-over-seats]');
	await expect(note).toHaveText(/^This team has 5 editors but its plan pays for 3 editor seats since .+: 2 over\./);
	await expect(note).toContainText('Add 2 seats with Change seats, or make 2 editors viewers.');
	await expectNoViolations(page);
});
