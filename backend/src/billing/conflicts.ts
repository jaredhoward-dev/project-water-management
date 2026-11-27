// The operator's view of subscription price conflicts (406, issue #928;
// docs/billing.md § Price check): list them, and resolve one by hand once it
// is dealt with (refunded or granted in the provider's dashboard, or the price
// accepted). Shared by the local script (scripts/billing-conflict.ts, pnpm
// dev:billing:conflict) and the migrate Lambda's owner actions
// (ops/ownerActions.ts billing-conflicts, billing-conflict-resolve). Runs on
// the schema owner's connection: billing_conflict is owner-only. Ids, plans
// and amounts only; never a person.
import type pg from 'pg';

export interface ConflictRow {
	id: number;
	provider: string;
	accountId: string;
	externalRef: string;
	eventId: string;
	reason: string;
	planCode: string;
	interval: string | null;
	seats: number;
	amountMinor: number | null;
	currency: string | null;
	expectedMinor: number | null;
	held: boolean;
	createdAt: string;
	resolvedAt: string | null;
	resolvedBy: string | null;
	resolution: string | null;
}

const COLUMNS = `id, provider, billing_account_id, external_ref, event_id, reason, plan_code, billing_interval, seats, amount_minor, currency,
	expected_minor, held, created_at, resolved_at, resolved_by, resolution`;

type Raw = {
	id: string;
	provider: string;
	billing_account_id: string;
	external_ref: string;
	event_id: string;
	reason: string;
	plan_code: string;
	billing_interval: string | null;
	seats: number;
	amount_minor: string | null;
	currency: string | null;
	expected_minor: string | null;
	held: boolean;
	created_at: Date;
	resolved_at: Date | null;
	resolved_by: string | null;
	resolution: string | null;
};
const num = (v: string | null) => (v === null ? null : Number(v));
const toRow = (r: Raw): ConflictRow => ({
	id: Number(r.id),
	provider: r.provider,
	accountId: r.billing_account_id,
	externalRef: r.external_ref,
	eventId: r.event_id,
	reason: r.reason,
	planCode: r.plan_code,
	interval: r.billing_interval,
	seats: r.seats,
	amountMinor: num(r.amount_minor),
	currency: r.currency,
	expectedMinor: num(r.expected_minor),
	held: r.held,
	createdAt: r.created_at.toISOString(),
	resolvedAt: r.resolved_at?.toISOString() ?? null,
	resolvedBy: r.resolved_by,
	resolution: r.resolution
});

/** The open conflicts, oldest first; with `all`, the resolved ones too (until the purge takes them). At most 1000. */
export async function listConflicts(client: pg.ClientBase, all = false): Promise<ConflictRow[]> {
	const { rows } = await client.query<Raw>(`SELECT ${COLUMNS} FROM billing_conflict ${all ? '' : 'WHERE resolved_at IS NULL'} ORDER BY created_at, id LIMIT 1000`);
	return rows.map(toRow);
}

/** A refusal the operator can act on: no such conflict, or already resolved / a bad reason or actor. */
export class ConflictError extends Error {
	constructor(readonly code: 'no_conflict' | 'invalid') {
		super(code === 'no_conflict' ? 'no such billing conflict' : 'the conflict is already resolved, or the reason or who acts is missing or too long');
		this.name = 'ConflictError';
	}
}

/** Resolve one by hand (app_billing_conflict_resolve), keeping who and why on the row. */
export async function resolveConflict(client: pg.ClientBase, a: { id: number; reason: string; by: string }): Promise<ConflictRow> {
	try {
		const { rows } = await client.query<Raw>(`SELECT ${COLUMNS} FROM app_billing_conflict_resolve($1, $2, $3)`, [a.id, a.reason, a.by]);
		return toRow(rows[0]!);
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === 'P0002') throw new ConflictError('no_conflict');
		if (code === '22023') throw new ConflictError('invalid');
		throw e;
	}
}

/** One line per conflict for the operator's terminal. */
export function conflictLine(c: ConflictRow): string {
	const amount = c.amountMinor === null ? 'unpriced' : `${c.amountMinor} ${c.currency ?? '?'}`;
	const state = c.resolvedAt ? `resolved ${c.resolvedAt} by ${c.resolvedBy}: ${c.resolution}` : 'OPEN';
	return `#${c.id}  ${c.provider}  ${c.externalRef}  account ${c.accountId}  ${c.reason}  ${c.planCode}/${c.interval ?? '?'} × ${c.seats}  ${amount} (expected ${c.expectedMinor ?? 'n/a'})  ${c.held ? 'held' : 'NOT HELD'}  event ${c.eventId}  ${c.createdAt}  ${state}`;
}
