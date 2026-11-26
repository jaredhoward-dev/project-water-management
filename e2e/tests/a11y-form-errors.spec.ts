// The sign-up and new-password forms' own checks (a name of only spaces, two
// passwords that differ) name the field they are about (WCAG 3.3.1 Error
// Identification, 1.3.1): it is marked aria-invalid, described by the message
// and takes focus, so a screen reader hears which box to fix rather than only
// an alert above the form. Neither check reaches the server: the reset token
// below has the right shape, so the form shows, and is never sent.
import { expect, test } from '../support/fixtures.ts';

const WELL_FORMED_TOKEN = 'q'.repeat(43);

test('sign-up: a name of only spaces marks the name field and focuses it', async ({ page }) => {
	await page.goto('/register');
	await page.getByLabel('Display name').fill('   ');
	await page.getByLabel('Email', { exact: true }).fill('someone@example.com');
	await page.getByLabel('Password', { exact: true }).fill('long enough 1');
	await page.getByLabel('Confirm password').fill('long enough 1');
	await page.locator('#agree').check();
	await page.getByRole('button', { name: 'Create account' }).click();

	const name = page.getByLabel('Display name');
	await expect(page.getByRole('alert')).toHaveText('Enter a display name.');
	await expect(name).toBeFocused();
	await expect(name).toHaveAttribute('aria-invalid', 'true');
	await expect(name).toHaveAccessibleDescription('Enter a display name.');
	await expect(page.getByLabel('Confirm password')).not.toHaveAttribute('aria-invalid', 'true');
});

test('sign-up: two different passwords mark the repeat and focus it', async ({ page }) => {
	await page.goto('/register');
	await page.getByLabel('Display name').fill('Ann');
	await page.getByLabel('Email', { exact: true }).fill('someone@example.com');
	await page.getByLabel('Password', { exact: true }).fill('long enough 1');
	await page.getByLabel('Confirm password').fill('long enough 2');
	await page.locator('#agree').check();
	await page.getByRole('button', { name: 'Create account' }).click();

	const repeat = page.getByLabel('Confirm password');
	await expect(repeat).toBeFocused();
	await expect(repeat).toHaveAttribute('aria-invalid', 'true');
	await expect(repeat).toHaveAccessibleDescription('The two passwords don’t match. Type the same password in both.');
	await expect(page.getByLabel('Display name')).not.toHaveAttribute('aria-invalid', 'true');
});

test('new password: two different passwords mark the repeat and focus it', async ({ page }) => {
	await page.goto(`/reset-password?token=${WELL_FORMED_TOKEN}`);
	await page.getByLabel('New password', { exact: true }).fill('long enough 1');
	await page.getByLabel('Repeat new password').fill('long enough 2');
	await page.getByRole('button', { name: 'Set new password' }).click();

	const repeat = page.getByLabel('Repeat new password');
	await expect(page.getByRole('alert')).toHaveText('The two passwords don’t match.');
	await expect(repeat).toBeFocused();
	await expect(repeat).toHaveAttribute('aria-invalid', 'true');
	await expect(repeat).toHaveAccessibleDescription('The two passwords don’t match.');
	await expect(page.getByLabel('New password', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
});
