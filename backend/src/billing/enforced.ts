// BILLING_ENFORCED (issue #641, docs/billing.md § BILLING_ENFORCED), in a
// module of its own so db/tx.ts can read it without the billing provider.

/**
 * BILLING_ENFORCED: whether plan limits refuse anything. Off by default; only
 * the exact string `true` turns it on.
 */
export const billingEnforced = (env: NodeJS.ProcessEnv = process.env): boolean => env.BILLING_ENFORCED === 'true';

/**
 * The transaction setting the database's plan-limit guards read (334_team_seats:
 * `current_setting('app.billing_enforced', true) = 'on'`). db/tx.ts sets it,
 * transaction-local, from billingEnforced() and nothing else: no request value
 * reaches it.
 */
export const BILLING_ENFORCED_GUC = 'app.billing_enforced';

/** What setOwnerBillingEnforced needs of a connection: a pg.Client or a pool client. */
interface Queryable {
	query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * The schema owner's own connections (the billing scripts, scripts/billing-*.ts, and the migrate Lambda's owner
 * actions, lambda-migrate.ts ownerAction) don't go through db/tx.ts, yet their subscription writes fire 341's
 * subscription_plan_pause_sync. Without the setting the sync reads enforcement as off and drops every pause marker
 * until the next tick puts them back. This sets it for the session, from billingEnforced() alone, as db/tx.ts does
 * for its transactions (docs/billing.md § Pausing after a downgrade). Off costs no round trip.
 */
export async function setOwnerBillingEnforced(client: Queryable, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (billingEnforced(env)) await client.query('SELECT set_config($1, $2, false)', [BILLING_ENFORCED_GUC, 'on']);
}
