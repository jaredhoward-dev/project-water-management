// The operator's staff grant of a plan (330_staff_grant, issue #641 "Staff
// overrides"; docs/billing.md § Staff grants), as functions on a schema-owner
// connection. Two callers: the local script (scripts/billing-grant.ts, which
// prints lines for the operator's terminal) and the migrate Lambda's owner
// actions (ops/ownerActions.ts, the production route, whose answer never
// carries an address). Each runs app_staff_grant_plan / app_staff_revoke_grant
// as the owner; the database's own refusals pass through as its errors.
//
// No dotenv here or below: the migrate Lambda bundles this module.
import type pg from 'pg';

/**
 * Whose billing account: a person by address (the local script, and the
 * operator's direct invoke only) or by id, a team by id, or the billing
 * account itself by id. The billing-admin workflow names ids only: its run is
 * in a public repo, so an address never goes into its inputs
 * (docs/deployment.md § Owner actions).
 */
export type Target =
	| { kind: 'user'; email: string }
	| { kind: 'user'; userId: string }
	| { kind: 'team'; teamId: string }
	| { kind: 'account'; accountId: string };

/** A target that names nobody. `message` may quote the address (the local script's terminal); `code` is what a public answer says. */
export class StaffGrantError extends Error {
	constructor(
		message: string,
		readonly code: 'no_person' | 'no_team' | 'no_billing_account'
	) {
		super(message);
		this.name = 'StaffGrantError';
	}
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date that exists (2026-02-30 doesn't). */
export function isCalendarDate(s: string): boolean {
	const m = DATE.exec(s);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** The end of a YYYY-MM-DD in SAST, as SQL: the next SAST midnight, whatever the session's time zone. */
export const UNTIL_SQL = `(($1::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')`;

/** How the target reads in the operator's own terminal (the address as typed). Never in a public answer. */
export const describeTarget = (t: Target): string =>
	'email' in t ? t.email : 'userId' in t ? `person ${t.userId}` : t.kind === 'team' ? `team ${t.teamId}` : `billing account ${t.accountId}`;

/** The person or team a target names, as billing_account's owner columns know it. */
export interface Owner {
	kind: 'user' | 'team';
	ownerId: string;
}

/** Who the target names; a StaffGrantError when nobody (no person, no team, no billing account). */
export async function ownerOf(client: pg.ClientBase, target: Target): Promise<Owner> {
	if ('email' in target) {
		const { rows } = await client.query<{ id: string }>('SELECT id FROM app_user WHERE lower(email::text) = $1', [target.email]);
		if (!rows[0]) throw new StaffGrantError(`no account with the address ${target.email}`, 'no_person');
		return { kind: 'user', ownerId: rows[0].id };
	}
	if ('userId' in target) {
		const { rows } = await client.query<{ id: string }>('SELECT id FROM app_user WHERE id = $1', [target.userId]);
		if (!rows[0]) throw new StaffGrantError(`no person ${target.userId}`, 'no_person');
		return { kind: 'user', ownerId: rows[0].id };
	}
	if (target.kind === 'team') {
		const { rows } = await client.query<{ id: string }>('SELECT id FROM team WHERE id = $1', [target.teamId]);
		if (!rows[0]) throw new StaffGrantError(`no team ${target.teamId}`, 'no_team');
		return { kind: 'team', ownerId: rows[0].id };
	}
	const { rows } = await client.query<{ user_id: string | null; team_id: string | null }>('SELECT user_id, team_id FROM billing_account WHERE id = $1', [target.accountId]);
	if (!rows[0]) throw new StaffGrantError(`no billing account ${target.accountId}`, 'no_billing_account');
	return rows[0].user_id !== null ? { kind: 'user', ownerId: rows[0].user_id } : { kind: 'team', ownerId: rows[0].team_id! };
}

/** The target's billing account id: made if missing for a grant (billing_account_ensure, 323), else NULL when it has none. */
export async function accountOf(client: pg.ClientBase, target: Target, ensure: boolean): Promise<string | null> {
	return (await ownedAccount(client, target, ensure)).accountId;
}

/** The target's owner and billing account id (NULL when it has none and `ensure` is false). */
export async function ownedAccount(client: pg.ClientBase, target: Target, ensure: boolean): Promise<Owner & { accountId: string | null }> {
	const owner = await ownerOf(client, target);
	const { rows } = ensure
		? await client.query<{ id: string }>('SELECT billing_account_ensure($1, $2) AS id', [owner.kind, owner.ownerId])
		: await client.query<{ id: string }>(`SELECT id FROM billing_account WHERE ${owner.kind === 'user' ? 'user_id' : 'team_id'} = $1`, [owner.ownerId]);
	return { ...owner, accountId: rows[0]?.id ?? null };
}

export interface AccountLookup extends Owner {
	/** NULL: none yet (Free, never granted); a grant to the person or team makes it. */
	accountId: string | null;
	/** The plan now (billing_account_plan_code); free with no account. */
	planNow: string;
}

/** Whose account and its plan, writing nothing: the operator's private lookup of the ids the workflow takes. */
export async function lookupAccount(client: pg.ClientBase, target: Target): Promise<AccountLookup> {
	const owned = await ownedAccount(client, target, false);
	if (!owned.accountId) return { ...owned, planNow: 'free' };
	const { rows } = await client.query<{ code: string }>('SELECT billing_account_plan_code($1) AS code', [owned.accountId]);
	return { ...owned, planNow: rows[0]?.code ?? 'free' };
}

export interface LogRow {
	at: string;
	action: string;
	plan: string;
	until: string | null;
	by: string;
	reason: string;
}

export interface GrantLog {
	/** Whose: a person's or a team's account. */
	kind: Owner['kind'];
	accountId: string | null;
	/** The plan now (billing_account_plan_code); free with no account. */
	planNow: string;
	log: LogRow[];
}

/** The target's grant log, oldest first, times in SAST. */
export async function grantLog(client: pg.ClientBase, target: Target): Promise<GrantLog> {
	const { kind, accountId } = await ownedAccount(client, target, false);
	if (!accountId) return { kind, accountId: null, planNow: 'free', log: [] };
	const { rows: log } = await client.query<LogRow>(
		`SELECT to_char(created_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS at, action, plan_code AS plan,
			to_char(until AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS until, granted_by AS by, reason
		 FROM billing_grant_log WHERE billing_account_id = $1 ORDER BY created_at, id`,
		[accountId]
	);
	const { rows: plan } = await client.query<{ code: string }>('SELECT billing_account_plan_code($1) AS code', [accountId]);
	return { kind, accountId, planNow: plan[0]?.code ?? 'free', log };
}

export interface LiveGrant {
	accountId: string;
	kind: 'user' | 'team';
	/** The person's or team's id (never the address). */
	ownerId: string;
	plan: string;
	since: string;
	/** Its end in SAST, or null: until revoked. */
	until: string | null;
}

/** Every live staff grant (a manual subscription, status active), oldest first. */
export async function liveGrants(client: pg.ClientBase): Promise<LiveGrant[]> {
	const { rows } = await client.query<LiveGrant>(
		`SELECT s.billing_account_id AS "accountId", CASE WHEN a.user_id IS NOT NULL THEN 'user' ELSE 'team' END AS kind,
			coalesce(a.user_id, a.team_id) AS "ownerId", s.plan_code AS plan,
			to_char(s.period_start AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS since,
			to_char(s.period_end AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS until
		 FROM subscription s JOIN billing_account a ON a.id = s.billing_account_id
		 WHERE s.provider = 'manual' AND s.status = 'active'
		 ORDER BY s.period_start, s.id`
	);
	return rows;
}

export interface GrantRequest {
	target: Target;
	plan: string;
	/** YYYY-MM-DD: the grant lasts through that SAST day; null: until revoked. */
	until: string | null;
	reason: string;
	by: string;
	replace: boolean;
}

export interface Granted {
	accountId: string;
	kind: Owner['kind'];
	subscriptionId: string;
	plan: string;
	/** When it ends, SAST (YYYY-MM-DD HH24:MI), or null: until revoked. */
	endsAt: string | null;
	replaced: boolean;
}

/** In a transaction of its own: ROLLBACK on any failure, and rethrow. */
async function inTransaction<T>(client: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
	await client.query('BEGIN');
	try {
		const out = await fn();
		await client.query('COMMIT');
		return out;
	} catch (err) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw err;
	}
}

/** Grant a plan (app_staff_grant_plan), making the account if it has none. */
export function grantPlan(client: pg.ClientBase, req: GrantRequest): Promise<Granted> {
	return inTransaction(client, async () => {
		const owned = await ownedAccount(client, req.target, true);
		const accountId = owned.accountId!;
		const { rows: granted } = await client.query<{ id: string }>(
			`SELECT app_staff_grant_plan($2, $3, CASE WHEN $1::text IS NULL THEN NULL ELSE ${UNTIL_SQL} END, $4, $5, $6) AS id`,
			[req.until, accountId, req.plan, req.reason, req.by, req.replace]
		);
		const subscriptionId = granted[0]!.id;
		const { rows } = await client.query<{ until: string | null }>(
			`SELECT to_char(period_end AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS until FROM subscription WHERE id = $1`,
			[subscriptionId]
		);
		return { accountId, kind: owned.kind, subscriptionId, plan: req.plan, endsAt: rows[0]?.until ?? null, replaced: req.replace };
	});
}

export interface RevokeRequest {
	target: Target;
	reason: string;
	by: string;
}

export interface Revoked {
	accountId: string;
	kind: Owner['kind'];
	subscriptionId: string;
	plan: string;
}

/** End the account's live staff grant now (app_staff_revoke_grant); Free again. */
export function revokeGrant(client: pg.ClientBase, req: RevokeRequest): Promise<Revoked> {
	return inTransaction(client, async () => {
		const { kind, accountId } = await ownedAccount(client, req.target, false);
		if (!accountId) throw new StaffGrantError(`${describeTarget(req.target)} has no billing account, so no grant`, 'no_billing_account');
		// Two statements: a statement doesn't see the rows a function it calls changed.
		const { rows: ended } = await client.query<{ id: string }>('SELECT app_staff_revoke_grant($1, $2, $3) AS id', [accountId, req.reason, req.by]);
		const subscriptionId = ended[0]!.id;
		const { rows } = await client.query<{ plan: string }>('SELECT plan_code AS plan FROM subscription WHERE id = $1', [subscriptionId]);
		return { accountId, kind, subscriptionId, plan: rows[0]?.plan ?? '' };
	});
}
