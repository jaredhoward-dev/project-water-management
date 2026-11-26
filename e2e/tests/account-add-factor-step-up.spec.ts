// Adding a second way to get codes from a password-only session (issue #882;
// docs/security.md § Two-step sign-in, docs/ui.md § Account): the API
// answers 403 mfa_step_up (backend auth/mfa-routes.ts
// requireCodeForAnotherFactor), so the Account page's Two-step sign-in panel
// says why and offers "Sign in again" instead of asking for the password (or,
// when it asked anyway, calling a right password wrong).
//
// The password-only session with a factor on: the page's own session (the
// owner fixture signs in with the password), kept aside while the API puts an
// authenticator on (its confirm hands the request a two-step session), then
// put back. The backend's side is tested in backend/src/auth/mfa-email.db.test.ts.
import type { Page, Route } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { PASSWORD } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

/** An authenticator on the page's account through the API, with the page keeping its password-only session. */
async function appOnKeepingPasswordSession(page: Page): Promise<void> {
	const saved = await page.context().cookies();
	const { secret } = (await (await page.request.post(`${API_URL}/auth/mfa/totp/enrol`, { data: { password: PASSWORD } })).json()) as { secret: string };
	expect((await page.request.post(`${API_URL}/auth/mfa/totp/confirm`, { data: { code: hotp(base32Decode(secret)!, totpStep(Date.now())) } })).status()).toBe(200);
	await page.context().clearCookies();
	await page.context().addCookies(saved);
}

test('turning on codes by email beside the app from a password-only session says to sign in again, and Sign in again comes back here', async ({ page, owner }) => {
	void owner;
	await appOnKeepingPasswordSession(page);
	await page.goto('/account');
	const panel = page.locator('#two-step');
	await expect(panel.locator('[data-method="totp"]')).toHaveAttribute('data-on', 'true');

	await panel.locator('[data-method="email"]').getByRole('button', { name: 'Turn on' }).click();
	const stepUp = panel.locator('[data-add-factor-step-up="email"]');
	await expect(stepUp).toContainText('To turn on codes by email beside your authenticator app, sign in again with a code from the app.');
	await expect(stepUp.locator('p')).toBeFocused();
	// No password asked for: the API would refuse it anyway.
	await expect(panel.getByLabel('Current password')).toHaveCount(0);
	await expectNoViolations(page);

	// Cancel puts the rows back.
	await stepUp.getByRole('button', { name: 'Cancel' }).click();
	await expect(stepUp).toHaveCount(0);
	await panel.locator('[data-method="email"]').getByRole('button', { name: 'Turn on' }).click();

	await panel.locator('[data-add-factor-step-up="email"]').getByRole('button', { name: 'Sign in again' }).click();
	await expect(page).toHaveURL('/login?next=%2Faccount');
});

test('a refusal the page didn’t expect (a stale status) shows the same panel, not “Your current password is wrong”', async ({ page, owner, fetchRoute }) => {
	void owner;
	await appOnKeepingPasswordSession(page);
	// The page believes this session gave a code (as after another tab's sign-in went stale); the API still refuses.
	await fetchRoute(page, `${API_URL}/auth/mfa`, async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...(await response.json()), sessionVerified: true } });
	});
	await page.goto('/account');
	const panel = page.locator('#two-step');
	await panel.locator('[data-method="email"]').getByRole('button', { name: 'Turn on' }).click();
	await panel.getByLabel('Current password').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Continue' }).click();

	await expect(panel.locator('[data-add-factor-step-up="email"]')).toBeVisible();
	await expect(panel.getByText('Your current password is wrong.')).toHaveCount(0);
	await expect(panel.getByLabel('Current password')).toHaveCount(0);
});
