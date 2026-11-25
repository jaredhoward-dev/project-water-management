// Cancelling a paid plan at the payment provider before the rows that name it
// are deleted (docs/billing.md § Deleting an account). Deleting a person's
// account (DELETE /auth/me) or a team (DELETE /teams/:id) cascades away its
// billing_account and subscriptions (323), but nothing in the database reaches
// the provider: a Stripe subscription would go on charging a card for an
// account that no longer exists. So the route first cancels, now and with no
// refund, every subscription of the account being deleted that can still
// charge, and refuses the deletion if the provider can't. The Stripe customer
// itself is kept, with its invoices, as the tax record (security.md §
// Personal information).
import type { BillingProvider } from './provider.js';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
/** A billing account as the provider knows it: its customer (328) and its live subscriptions a provider holds. */
export type AccountBilling = { accountId: string; customerRef: string | null; live: { provider: string; externalRef: string }[] };

/** The account's customer and live provider subscriptions, read under RLS (its person or a team admin; 323's policy). */
async function billingOf(db: Db, accountId: string, customerRef: string | null): Promise<AccountBilling> {
	const { rows: live } = await db.query<{ provider: string; externalRef: string }>(
		`SELECT provider, external_ref AS "externalRef" FROM subscription
		 WHERE billing_account_id = $1 AND status IN ('trialing', 'active', 'past_due') AND provider <> 'manual' AND external_ref IS NOT NULL
		 ORDER BY created_at, external_ref`,
		[accountId]
	);
	return { accountId, customerRef, live };
}

/**
 * The person's own billing account (kind `user`; never a team's, whose plan is
 * the team's and stays with it), read as the person under RLS: its customer at
 * the provider and its live (trialing, active, past_due) subscriptions with a
 * provider ref. A grant (provider `manual`: a staff or invoice grant, the
 * reverse trial) is left out, since nothing charges for it at a provider. Null
 * when the person has no account (never opened a plan page or made a project).
 */
export async function ownBilling(db: Db, userId: string): Promise<AccountBilling | null> {
	const { rows } = await db.query<{ id: string; ref: string | null }>(
		`SELECT a.id, app_billing_customer_ref(a.id) AS ref FROM billing_account a WHERE a.kind = 'user' AND a.user_id = $1`,
		[userId]
	);
	const account = rows[0];
	return account ? billingOf(db, account.id, account.ref) : null;
}

/** The team's billing account, read as one of its admins (the team route checked the role); null when it has none yet. */
export async function teamBilling(db: Db, teamId: string): Promise<AccountBilling | null> {
	const { rows } = await db.query<{ id: string; ref: string | null }>(
		`SELECT a.id, app_billing_customer_ref(a.id) AS ref FROM billing_account a WHERE a.kind = 'team' AND a.team_id = $1`,
		[teamId]
	);
	const account = rows[0];
	return account ? billingOf(db, account.id, account.ref) : null;
}

/** The provider couldn't cancel the person's paid plan, so their account wasn't deleted (a paying subscription is never orphaned). */
export class PlanNotCancelledError extends ApiError {
	constructor() {
		super(503, 'your paid plan couldn’t be cancelled with the payment provider, so your account wasn’t deleted; try again in a few minutes');
		this.code = 'account_plan_not_cancelled';
	}
}

/** The same for deleting a team (the workspace's Teams page, in English): the team's plan couldn't be cancelled, so the team stays. */
export class TeamPlanNotCancelledError extends ApiError {
	constructor() {
		super(503, 'the team’s paid plan couldn’t be cancelled with the payment provider, so the team wasn’t deleted; try again in a few minutes');
		this.code = 'billing_provider_error';
	}
}

/**
 * Before the account goes: cancel, at the provider, now and with no refund,
 * every subscription of the account (the person's own, or the team being
 * deleted) that can still charge
 * (docs/billing.md § Deleting an account). Asks the provider only when there is
 * something to ask about: a live provider subscription, or a Stripe customer
 * (whose open subscriptions are listed, so one whose webhook hasn't landed is
 * cancelled too). Answers the refs that no longer charge. Refuses (throws
 * PlanNotCancelledError) when the provider fails, when none is configured that
 * can cancel, or when a live subscription is another provider's (a mock one
 * after switching to Stripe): deleting then would leave a paying subscription
 * with no account behind it. The Stripe customer itself is kept (its invoices
 * are the tax record; security.md § Personal information).
 */
export async function cancelPlanAtProvider(billing: AccountBilling | null, provider: BillingProvider | null, refuse: () => ApiError = () => new PlanNotCancelledError()): Promise<string[]> {
	if (!billing) return [];
	const listable = billing.customerRef !== null && provider?.name === 'stripe';
	if (!billing.live.length && !listable) return [];
	if (!provider || provider.name === 'manual' || billing.live.some((s) => s.provider !== provider.name)) {
		logEvent('warn', { event: 'account_delete_plan_not_cancelled', reason: 'provider', accountId: billing.accountId });
		throw refuse();
	}
	try {
		const cancelled = await provider.cancelSubscriptions({
			accountId: billing.accountId,
			customerRef: billing.customerRef,
			subscriptionRefs: billing.live.map((s) => s.externalRef)
		});
		logEvent('info', { event: 'account_delete_plan_cancelled', provider: provider.name, accountId: billing.accountId, subscriptions: cancelled.length });
		return cancelled;
	} catch (err) {
		logEvent('warn', { event: 'account_delete_plan_not_cancelled', reason: 'failed', provider: provider.name, accountId: billing.accountId, error: err instanceof Error ? err.name : 'unknown' });
		throw Object.assign(refuse(), { cause: err });
	}
}

/** Whether a live provider subscription is still there that the cancel didn't reach (a checkout completed in between). */
export function uncancelled(billing: AccountBilling | null, cancelled: readonly string[]): boolean {
	return !!billing?.live.some((s) => !cancelled.includes(s.externalRef));
}
