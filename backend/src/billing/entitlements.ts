// Billing, Phase 1: shadow mode (issue #641, docs/billing.md). Everything is
// counted and shown, nothing is refused. The plan data lives in Postgres
// (323_billing) and is read only through its SECURITY DEFINER functions, as
// the signed-in person (withUser): app_account_plan answers NULL to anyone but
// the account's person or an admin of its team, and app_entitlements to
// anyone below editor on the project, so a farmer or viewer never sees it.
import type { Db } from '../db/tx.js';
import { billingEnforced } from './enforced.js';
import { billingProviderName, type BillingProviderName } from './provider.js';

/**
 * BILLING_ENFORCED: whether plan limits refuse anything (billing/enforced.ts).
 * Off by default; when on, the database refuses a Team's editor past its paid
 * seats (334_team_seats) and the rest still only reports.
 */
export { billingEnforced };

/** What usage_counter counts (its kind CHECK, 323_billing). */
export const USAGE_KINDS = ['reports', 'packs_issued'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * Count `qty` of `kind` against the project's billing account for this month
 * (Africa/Johannesburg), in the caller's transaction, so the count commits or
 * rolls back with the action it counts. In shadow mode app_usage_add never
 * refuses: it only counts.
 */
export async function countUsage(db: Db, projectId: string, kind: UsageKind, qty = 1): Promise<void> {
	if (!Number.isInteger(qty) || qty < 1) throw new Error(`countUsage: qty must be a positive integer, got ${qty}`);
	await db.query('SELECT app_usage_add($1, $2, $3)', [projectId, kind, qty]);
}

/** A project's plan as its owners and editors see it (app_entitlements). */
export interface Entitlements {
	plan: string;
	limits: Record<string, number | null>;
	features: Record<string, unknown>;
	status: string | null;
}

/** The project's entitlements, or null for a caller below editor on it (or no such project). */
export async function projectEntitlements(db: Db, projectId: string): Promise<Entitlements | null> {
	const { rows } = await db.query<{ e: Entitlements | null }>('SELECT app_entitlements($1) AS e', [projectId]);
	return rows[0]?.e ?? null;
}

/**
 * Whether `used` has reached a limit; a null limit is unlimited. Phase 1 shows
 * this (the usage bars); Phase 2 refuses on it when billingEnforced().
 */
export const atLimit = (used: number, limit: number | null | undefined): boolean => limit !== null && limit !== undefined && used >= limit;

/** A plan as GET /billing/plans returns it. */
export interface PublicPlan {
	code: string;
	name: string;
	priceMonthlyMinor: number;
	priceAnnualMinor: number;
	currency: string;
	limits: Record<string, number | null>;
	features: Record<string, unknown>;
	trialDays: number | null;
}

type PlanRow = Record<string, unknown>;

/** The row's value under its camelCase key or its column name. */
const pick = (row: PlanRow, camel: string, snake: string): unknown => (camel in row ? row[camel] : row[snake]);

/**
 * One plan from app_billing_plans, as the API sends it. The function returns
 * plan rows (snake_case columns) or a jsonb array of camelCase objects; both
 * read the same here, and nothing but these fields leaves (no `active`, no
 * column a later migration adds). An inactive plan is dropped.
 */
export function toPublicPlan(row: PlanRow): PublicPlan | null {
	if (row.active === false) return null;
	const trial = pick(row, 'trialDays', 'trial_days');
	return {
		code: String(row.code),
		name: String(row.name),
		priceMonthlyMinor: Number(pick(row, 'priceMonthlyMinor', 'price_monthly_minor')),
		priceAnnualMinor: Number(pick(row, 'priceAnnualMinor', 'price_annual_minor')),
		currency: String(row.currency ?? 'ZAR'),
		limits: (row.limits ?? {}) as Record<string, number | null>,
		features: (row.features ?? {}) as Record<string, unknown>,
		trialDays: trial === null || trial === undefined ? null : Number(trial)
	};
}

/** Every active plan, cheapest first. Anyone may read them (the pricing page). */
export async function listPlans(db: Db): Promise<PublicPlan[]> {
	// to_jsonb of the function's value: a plan row each, or one jsonb array (the contract allows either).
	const { rows } = await db.query<{ p: PlanRow | PlanRow[] }>('SELECT to_jsonb(p) AS p FROM app_billing_plans() AS p');
	return rows
		.flatMap((r) => (Array.isArray(r.p) ? r.p : [r.p]))
		.map(toPublicPlan)
		.filter((p): p is PublicPlan => p !== null)
		.sort((a, b) => a.priceMonthlyMinor - b.priceMonthlyMinor || a.code.localeCompare(b.code));
}

/**
 * app_account_plan's answer (camelCase jsonb, passed through) plus whether limits are enforced and which billing
 * provider is configured (Phase 3: the page shows Upgrade and Manage billing only when it isn't manual or none).
 */
export type AccountPlan = Record<string, unknown> & { enforced: boolean; provider: BillingProviderName | null };

/** The account's plan and this month's usage, or null when the caller may not read it. */
export async function accountPlan(db: Db, accountId: string | null, env: NodeJS.ProcessEnv = process.env): Promise<AccountPlan | null> {
	if (!accountId) return null;
	const { rows } = await db.query<{ plan: Record<string, unknown> | null }>('SELECT app_account_plan($1) AS plan', [accountId]);
	const plan = rows[0]?.plan;
	if (!plan) return null;
	return { ...(await withReverseTrial(db, accountId, plan)), enforced: billingEnforced(env), provider: billingProviderName(env) };
}

/**
 * Who holds a live subscription, from its status and app_billing_live_subscription_ref (333): `reverseTrial` for the
 * reverse trial (342: provider `manual`, status `trialing`; docs/billing.md § The reverse trial), and `granted` for a
 * plan the operator gave: `staff` (330: `manual`, `active`, no external ref) or `invoice` (335: `manual`, `active`,
 * the paid invoice's id as its ref). Null for a subscription the payment provider holds. Exported for its test.
 */
export function subscriptionSource(status: unknown, ref: { provider?: string; externalRef?: string | null } | null | undefined): { reverseTrial: boolean; granted: 'staff' | 'invoice' | null } {
	const manual = ref?.provider === 'manual';
	if (!manual) return { reverseTrial: false, granted: null };
	if (status === 'trialing') return { reverseTrial: true, granted: null };
	if (status === 'active') return { reverseTrial: false, granted: ref?.externalRef ? 'invoice' : 'staff' };
	return { reverseTrial: false, granted: null };
}

/**
 * The plan with `subscription.reverseTrial` and `subscription.granted` added (subscriptionSource), so the Plan page
 * offers Upgrade in a reverse trial's place and warns before it ends, and says a granted plan is the operator's
 * rather than offering Manage billing, which has no provider subscription to manage. app_account_plan doesn't say
 * which provider holds the subscription, so a live one is asked of app_billing_live_subscription_ref (333; the same
 * caller check). Exported for its test.
 */
export async function withReverseTrial(db: Db, accountId: string, plan: Record<string, unknown>): Promise<Record<string, unknown>> {
	const sub = plan.subscription as { status?: unknown } | null | undefined;
	if (!sub || typeof sub !== 'object') return plan;
	let source: ReturnType<typeof subscriptionSource> = { reverseTrial: false, granted: null };
	if (sub.status === 'trialing' || sub.status === 'active') {
		const { rows } = await db.query<{ ref: { provider?: string; externalRef?: string | null } | null }>('SELECT app_billing_live_subscription_ref($1) AS ref', [accountId]);
		source = subscriptionSource(sub.status, rows[0]?.ref);
	}
	return { ...plan, subscription: { ...sub, ...source } };
}

/** The signed-in person's own billing account (created on first ask). */
export async function myAccountId(db: Db): Promise<string | null> {
	const { rows } = await db.query<{ id: string | null }>('SELECT app_my_billing_account() AS id');
	return rows[0]?.id ?? null;
}

/** The team's billing account (created on first ask), or null unless the caller is one of its admins. */
export async function teamAccountId(db: Db, teamId: string): Promise<string | null> {
	const { rows } = await db.query<{ id: string | null }>('SELECT app_team_billing_account($1) AS id', [teamId]);
	return rows[0]?.id ?? null;
}
