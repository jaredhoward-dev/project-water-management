// Focus after an action on the account pages and the API keys panel (WCAG 2.4.3; ui-playbook § "focus
// going into the card and back to the head's button", § "A delete puts the focus on what took the row's
// place"). Each of these swapped out the button that had the focus and left it on <body>, so the next Tab
// started again from the top of the page:
// - Two-step sign-in: a way's Set up / Turn on / Remove and New recovery codes hide while their form is open;
//   the focus now goes into the form's first field, and back to that button on Cancel or once it is done.
// - Invitations: an answered invitation's card goes; the next card's Accept takes the focus, else the title.
// - API keys: Cancel on the make card left its complaint ("Pick at least one series…") on the panel.
// Synthetic data only.
import { base32Decode, hotp, totpStep } from '../../backend/src/auth/totp.ts';
import { createProject, PASSWORD, putSeries } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const codeFor = (secret: string, step: number) => hotp(base32Decode(secret)!, step);

test('two-step sign-in: each form takes the focus into its first field and hands it back to the button that opened it', async ({ page, owner }) => {
	void owner;
	await page.goto('/account');
	const panel = page.getByRole('region', { name: 'Two-step sign-in' });
	await expect(panel).toHaveAttribute('data-two-step', 'off');

	// Setting up the app: into the password, and Cancel back to Set up the app.
	const setUp = panel.getByRole('button', { name: 'Set up the app' });
	await setUp.click();
	await expect(panel.getByLabel('Current password')).toBeFocused();
	await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(setUp).toBeFocused();

	// Codes by email the same, on its own row.
	const email = panel.locator('[data-method="email"]');
	await email.getByRole('button', { name: 'Turn on', exact: true }).click();
	await expect(panel.getByLabel('Current password')).toBeFocused();
	await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(email.getByRole('button', { name: 'Turn on', exact: true })).toBeFocused();

	// Turn the app on, to reach the forms a way that is on offers.
	await setUp.click();
	await panel.getByLabel('Current password').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Continue' }).click();
	await expect(panel.getByLabel('Enter the code the app shows')).toBeFocused();
	const secret = (await panel.locator('[data-totp-secret]').getAttribute('data-totp-secret'))!;
	const step = totpStep(Date.now());
	await panel.getByLabel('Enter the code the app shows').fill(codeFor(secret, step));
	await panel.getByRole('button', { name: 'Turn on the authenticator app' }).click();
	await expect(panel.getByRole('heading', { name: 'Your recovery codes' })).toBeFocused();
	await panel.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(panel).toHaveAttribute('data-two-step', 'on');

	// New recovery codes: into the code, Cancel back to it.
	const newCodes = panel.getByRole('button', { name: 'New recovery codes' });
	await newCodes.click();
	const actionCode = panel.getByLabel('Code from your authenticator app or your email', { exact: true });
	await expect(actionCode).toBeFocused();
	await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(newCodes).toBeFocused();

	// Remove: into the code, Cancel back to Remove; once removed, the row's Set up the app has it.
	const remove = panel.getByRole('button', { name: 'Remove', exact: true });
	await remove.click();
	const removeCode = panel.getByLabel('Code from your authenticator app or your email, or a recovery code');
	await expect(removeCode).toBeFocused();
	await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(remove).toBeFocused();
	await remove.click();
	await removeCode.fill(codeFor(secret, step + 1));
	await panel.getByRole('button', { name: 'Remove the authenticator app' }).click();
	await expect(panel.getByRole('status')).toHaveText('Two-step sign-in is off.');
	await expect(setUp).toBeFocused();
});

test('invitations: answering one gives the focus to the next card’s Accept, and the last to the page title', async ({ page, owner, signIn }) => {
	void owner;
	const first = await createProject(page.request, 'Focus catchment one');
	const second = await createProject(page.request, 'Focus catchment two');
	const guest = await signIn('Focus guest');
	// Invited to both, not accepted (addMember would accept as them).
	for (const p of [first, second]) {
		const res = await page.request.post(`${API_URL}/projects/${p.id}/members`, { data: { email: guest.user.email, role: 'viewer' } });
		expect(res.status()).toBe(201);
	}

	const g = guest.page;
	await g.goto('/account/invitations');
	const cards = g.locator('[data-invite]');
	await expect(cards).toHaveCount(2);
	await cards.first().getByRole('button', { name: 'Decline' }).click();
	await expect(g.getByRole('status').filter({ hasText: 'You declined' })).toBeVisible();
	await expect(cards).toHaveCount(1);
	await expect(cards.first().getByRole('button', { name: 'Accept' })).toBeFocused();

	await cards.first().getByRole('button', { name: 'Accept' }).click();
	await expect(g.getByText('You have no invitations waiting.')).toBeVisible();
	await expect(g.getByRole('heading', { level: 1, name: 'Invitations' })).toBeFocused();
});

test('API keys: Cancel on the make card takes its complaint with it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Keys focus catchment');
	await putSeries(page.request, project.id, { kind: 'flow_logger_m3s', name: 'Weir', unit: 'm3/s', startDate: '2024-01-01', values: [0.4, 0.5] });
	await page.goto(`/projects/${project.id}?tab=project`);
	const panel = page.getByRole('region', { name: 'API keys' });
	await expect(panel.getByText('No API keys yet.')).toBeVisible();
	const make = panel.getByRole('button', { name: 'Make a key' });
	await make.click();
	const form = panel.getByRole('form', { name: 'Make an API key' });
	await form.getByLabel('Name').fill('Weir gateway');
	await form.getByLabel('Only these series').check();
	await form.getByRole('button', { name: 'Make key' }).click();
	await expect(panel.getByRole('alert')).toHaveText('Pick at least one series, or let the key write any series.');

	await form.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(form).toHaveCount(0);
	await expect(make).toBeFocused();
	await expect(panel.getByRole('alert')).toHaveCount(0);
});
