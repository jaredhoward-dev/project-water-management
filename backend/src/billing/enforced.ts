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
