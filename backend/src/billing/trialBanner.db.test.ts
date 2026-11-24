// What the Plan page and the workspace read to show the reverse trial (342; 349_project_trial_end; docs/billing.md
// § The reverse trial, docs/ui.md § Plan and usage and § The header's notices):
//   - GET /account/plan marks a reverse trial (`manual` + `trialing`) with `subscription.reverseTrial`, and a staff
//     grant (`manual` + `active`) or a Stripe trial not;
//   - GET /projects/:id carries `planTrialEnd` to the account's owner (positive control), never to a member who
//     isn't, nor on a project whose account has no reverse trial.
// The trial row is written as the schema owner, as 342's app_reverse_trial_start writes it, so the test needs neither
// REVERSE_TRIAL nor a fresh canonical email.
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const accountOf = async (u: User) => ((await asOwner('SELECT id FROM billing_account WHERE user_id = $1', [u.id]))[0]!.id as string);

/** A live subscription on the person's own account, ending in `days` days. */
async function subscribe(u: User, status: 'trialing' | 'active', provider: 'manual' | 'stripe', days = 2) {
	expect((await u.call('GET', '/account/plan')).status).toBe(200); // makes the account
	await asOwner(
		`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, trial_end, cancel_at_period_end, provider)
		 VALUES ($1, 'pro', $2, now(), now() + make_interval(days => $4), CASE WHEN $2 = 'trialing' THEN now() + make_interval(days => $4) END, true, $3)`,
		[await accountOf(u), status, provider, days]
	);
}

describe('the reverse trial in the plan JSON and the project', () => {
	it('GET /account/plan says a reverse trial is one, with its end', async () => {
		const u = await signUp('TrialPlan');
		await subscribe(u, 'trialing', 'manual');
		const r = await u.call('GET', '/account/plan');
		expect(r.status).toBe(200);
		expect(r.body.subscription.reverseTrial).toBe(true);
		expect(r.body.subscription.status).toBe('trialing');
		expect(Date.parse(r.body.subscription.trialEnd)).toBeGreaterThan(Date.now());
	});

	it('a staff grant and a Stripe trial are not reverse trials', async () => {
		const grant = await signUp('TrialGrant');
		await subscribe(grant, 'active', 'manual');
		expect((await grant.call('GET', '/account/plan')).body.subscription.reverseTrial).toBe(false);
		const stripe = await signUp('TrialStripe');
		await subscribe(stripe, 'trialing', 'stripe');
		expect((await stripe.call('GET', '/account/plan')).body.subscription.reverseTrial).toBe(false);
		// Free: no subscription at all.
		const free = await signUp('TrialFree');
		expect((await free.call('GET', '/account/plan')).body.subscription).toBeNull();
	});

	it('GET /projects/:id gives planTrialEnd to the account’s owner only (positive control: the owner)', async () => {
		const owner = await signUp('TrialOwner');
		const member = await signUp('TrialMember');
		const id = (await owner.call('POST', '/projects', { name: 'Trial banner' })).body.project.id as string;
		expect((await owner.call('POST', `/projects/${id}/members`, { email: member.email, role: 'editor' })).status).toBe(201);
		// No trial yet: null for both.
		expect((await owner.call('GET', `/projects/${id}`)).body.project.planTrialEnd).toBeNull();
		await subscribe(owner, 'trialing', 'manual');
		const seen = (await owner.call('GET', `/projects/${id}`)).body.project.planTrialEnd;
		expect(Date.parse(seen)).toBeGreaterThan(Date.now());
		const ownersPlan = (await owner.call('GET', '/account/plan')).body.subscription.trialEnd;
		expect(Date.parse(seen)).toBe(Date.parse(ownersPlan));
		const theirs = await member.call('GET', `/projects/${id}`);
		expect(theirs.status).toBe(200);
		expect(theirs.body.project.planTrialEnd).toBeNull();
	});

	it('a staff grant gives no planTrialEnd', async () => {
		const owner = await signUp('TrialGrantProject');
		const id = (await owner.call('POST', '/projects', { name: 'Granted' })).body.project.id as string;
		await subscribe(owner, 'active', 'manual');
		expect((await owner.call('GET', `/projects/${id}`)).body.project.planTrialEnd).toBeNull();
	});
});
