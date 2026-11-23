// Billing, Phase 1: shadow mode (issue #641, docs/billing.md). Everything is
// counted and shown, nothing is refused. The plan data lives in Postgres
// (323_billing) and is read only through its SECURITY DEFINER functions, as
// the signed-in person (withUser): app_account_plan answers NULL to anyone but
// the account's person or an admin of its team, and app_entitlements to
// anyone below editor on the project, so a farmer or viewer never sees it.
import type { Db } from '../db/tx.js';

/**
 * BILLING_ENFORCED: whether plan limits refuse anything. Phase 1 only reports
 * it (the default, false); only the exact string `true` turns it on.
 */
export const billingEnforced = (env: NodeJS.ProcessEnv = process.env): boolean => env.BILLING_ENFORCED === 'true';

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

/** app_account_plan's answer (camelCase jsonb, passed through) plus whether limits are enforced. */
export type AccountPlan = Record<string, unknown> & { enforced: boolean };

/** The account's plan and this month's usage, or null when the caller may not read it. */
export async function accountPlan(db: Db, accountId: string | null, env: NodeJS.ProcessEnv = process.env): Promise<AccountPlan | null> {
	if (!accountId) return null;
	const { rows } = await db.query<{ plan: Record<string, unknown> | null }>('SELECT app_account_plan($1) AS plan', [accountId]);
	const plan = rows[0]?.plan;
	return plan ? { ...plan, enforced: billingEnforced(env) } : null;
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
