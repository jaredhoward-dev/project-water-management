// Cancelling a paid plan at the provider before an account or a team is
// deleted (billing/cancelOnDelete.ts cancelPlanAtProvider; docs/billing.md §
// Deleting an account), with fake providers: no database, no network. The
// routes' side, end to end, is in auth/delete-me.db.test.ts and
// teams/teams.db.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { billingProvider, BillingProviderError, type BillingProvider, type CancelRequest } from './provider.js';
import { cancelPlanAtProvider, PlanNotCancelledError, TeamPlanNotCancelledError, uncancelled, type AccountBilling } from './cancelOnDelete.js';

const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const mock = billingProvider({ BILLING_PROVIDER: 'mock', BILLING_WEBHOOK_SECRET: 'dev-only-test' })!;

/** A provider of `name` that records each cancel it is asked for, answering `answer` or throwing it. */
function fake(name: BillingProvider['name'], answer: (req: CancelRequest) => Promise<string[]> = async (r) => r.subscriptionRefs): BillingProvider & { asked: CancelRequest[] } {
	const asked: CancelRequest[] = [];
	return {
		...mock,
		name,
		asked,
		async cancelSubscriptions(req) {
			asked.push(req);
			return answer(req);
		}
	};
}
const billing = (over: Partial<AccountBilling> = {}): AccountBilling => ({ accountId: ACCOUNT, customerRef: null, live: [], ...over });

describe('cancelPlanAtProvider', () => {
	it('asks the provider to cancel the live subscriptions it holds, with the customer, and answers what it cancelled', async () => {
		const p = fake('stripe');
		const b = billing({ customerRef: 'cus_Test1', live: [{ provider: 'stripe', externalRef: 'sub_Live1' }] });
		expect(await cancelPlanAtProvider(b, p)).toEqual(['sub_Live1']);
		expect(p.asked).toEqual([{ accountId: ACCOUNT, customerRef: 'cus_Test1', subscriptionRefs: ['sub_Live1'] }]);
	});

	it('asks Stripe about a customer with no live subscription recorded (one whose webhook hasn’t landed)', async () => {
		const p = fake('stripe', async () => ['sub_Unrecorded']);
		expect(await cancelPlanAtProvider(billing({ customerRef: 'cus_Test2' }), p)).toEqual(['sub_Unrecorded']);
		expect(p.asked).toHaveLength(1);
	});

	it('asks nothing when there is nothing to cancel: no account, no live subscription and no customer, or a customer the mock can’t list', async () => {
		const s = fake('stripe');
		const m = fake('mock');
		expect(await cancelPlanAtProvider(null, s)).toEqual([]);
		expect(await cancelPlanAtProvider(billing(), s)).toEqual([]);
		expect(await cancelPlanAtProvider(billing({ customerRef: 'cus_Old' }), m)).toEqual([]);
		// Nothing to cancel needs no provider at all (manual, or none configured).
		expect(await cancelPlanAtProvider(billing(), null)).toEqual([]);
		expect(s.asked).toEqual([]);
		expect(m.asked).toEqual([]);
	});

	it('refuses with 503 account_plan_not_cancelled when the provider fails, never its text', async () => {
		const p = fake('stripe', async () => {
			throw new BillingProviderError();
		});
		const err = await cancelPlanAtProvider(billing({ live: [{ provider: 'stripe', externalRef: 'sub_Live2' }] }), p).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PlanNotCancelledError);
		expect(err).toMatchObject({ status: 503, code: 'account_plan_not_cancelled' });
		expect((err as Error).message).not.toMatch(/provider couldn’t be reached/);
	});

	it('refuses, asking no one, when no provider that can cancel is configured, or the subscription is another provider’s', async () => {
		const live = billing({ live: [{ provider: 'stripe', externalRef: 'sub_Live3' }] });
		const m = fake('mock');
		const manual = billingProvider({ BILLING_PROVIDER: 'manual' })!;
		const spy = vi.spyOn(manual, 'cancelSubscriptions');
		await expect(cancelPlanAtProvider(live, null)).rejects.toBeInstanceOf(PlanNotCancelledError);
		await expect(cancelPlanAtProvider(live, manual)).rejects.toBeInstanceOf(PlanNotCancelledError);
		await expect(cancelPlanAtProvider(live, m)).rejects.toBeInstanceOf(PlanNotCancelledError);
		expect(spy).not.toHaveBeenCalled();
		expect(m.asked).toEqual([]);
		// Positive control: the provider that holds it is asked.
		expect(await cancelPlanAtProvider(billing({ live: [{ provider: 'mock', externalRef: 'sub_mock_1' }] }), m)).toEqual(['sub_mock_1']);
	});

	it('refuses a team’s deletion with the team’s own words', async () => {
		const p = fake('stripe', async () => {
			throw new BillingProviderError();
		});
		const err = await cancelPlanAtProvider(billing({ live: [{ provider: 'stripe', externalRef: 'sub_Team' }] }), p, () => new TeamPlanNotCancelledError()).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TeamPlanNotCancelledError);
		expect(err).toMatchObject({ status: 503, code: 'team_plan_not_cancelled' });
		// What happened and what to do, since the team page shows the message as it is.
		expect((err as Error).message).toMatch(/team’s paid plan couldn’t be ended at the payment provider, so nothing was deleted; try again/);
		expect((err as Error).message).toMatch(/may already have ended/);
		// No usable provider refuses with the same words.
		const manual = await cancelPlanAtProvider(billing({ live: [{ provider: 'stripe', externalRef: 'sub_Team' }] }), null, () => new TeamPlanNotCancelledError()).catch((e: unknown) => e);
		expect(manual).toMatchObject({ status: 503, code: 'team_plan_not_cancelled' });
	});

	it('the mock cancels what it is given, with no network', async () => {
		expect(await mock.cancelSubscriptions({ accountId: ACCOUNT, customerRef: null, subscriptionRefs: ['sub_mock_a'] })).toEqual(['sub_mock_a']);
	});
});

describe('uncancelled', () => {
	it('finds a live subscription the cancel didn’t reach (a checkout that completed in between), and nothing otherwise', () => {
		const b = billing({ live: [{ provider: 'stripe', externalRef: 'sub_A' }] });
		expect(uncancelled(b, [])).toBe(true);
		expect(uncancelled(b, ['sub_A'])).toBe(false);
		expect(uncancelled(billing(), [])).toBe(false);
		expect(uncancelled(null, [])).toBe(false);
	});
});
