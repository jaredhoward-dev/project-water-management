// The operator's owner actions in production (issue #641; docs/deployment.md
// § Owner actions). Production's database is private with no bastion, and
// the migrate Lambda is the one function holding the schema owner's
// credentials, so the writes the operator must make as the owner go through
// it as fixed, named actions: an event `{ "action": "<name>", …fields }`,
// each field checked by the strict schema below (any other field, or another
// name, is refused before the secret is read or anything connects). The event
// never carries SQL. Each action runs the same function the local script
// does:
//
//   billing-grant      src/billing/staffGrant.ts grantPlan    (pnpm dev:billing:grant … <plan>)
//   billing-revoke     src/billing/staffGrant.ts revokeGrant  (… --revoke)
//   billing-grants     src/billing/staffGrant.ts grantLog / liveGrants (… --list; no target: every live grant)
//   billing-report     src/billing/gatherReport.ts, redacted  (pnpm dev:billing:report; never --show-emails)
//   authority-confirm  src/projects/authorityConfirm.ts       (pnpm dev:authority:confirm)
//
// An answer never carries an email address or a person's name: ids, plans,
// dates, counts and the reasons the operator wrote (a grant's reason is
// written for the customer to read, so it is kept as given). The
// billing-admin workflow (.github/workflows/billing-admin.yml) prints less
// still to its public log. A failure is an OwnerActionFailure: a code, a
// fixed reason, and where the detail is (CloudWatch).
import type pg from 'pg';
import { z } from 'zod';
import { gatherReportOn } from '../billing/gatherReport.js';
import { redact, type Report } from '../billing/metrics.js';
import { grantLog, grantPlan, isCalendarDate, liveGrants, revokeGrant, StaffGrantError, type LiveGrant, type LogRow, type Target } from '../billing/staffGrant.js';
import { confirmAuthorityDelegate, NoPersonError } from '../projects/authorityConfirm.js';

export const OWNER_ACTIONS = ['billing-grant', 'billing-revoke', 'billing-grants', 'billing-report', 'authority-confirm'] as const;
export type OwnerActionName = (typeof OWNER_ACTIONS)[number];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform((s) => s.toLowerCase());
const email = z
	.string()
	.trim()
	.max(254)
	.regex(/^[^\s@]+@[^\s@]+$/)
	.transform((s) => s.toLowerCase());
/** Free text a person reads (a grant's reason, the authority's letter): trimmed, kept as given otherwise. */
const text = (max: number) => z.string().trim().min(1).max(max);
/** Who acts: the operator's name or GitHub login, as billing_grant_log.granted_by records it. */
const by = text(100);
const day = z.string().refine(isCalendarDate);

/** Exactly one of email and teamId names the account. */
const target = { email: email.optional(), teamId: uuid.optional() };
const oneTarget = (v: { email?: string; teamId?: string }) => (v.email === undefined) !== (v.teamId === undefined);

export const ownerActionSchema = z.discriminatedUnion('action', [
	z
		.strictObject({
			action: z.literal('billing-grant'),
			...target,
			plan: z.enum(['pro', 'team']),
			until: day.nullable().optional(),
			reason: text(500),
			by,
			replace: z.boolean().optional()
		})
		.refine(oneTarget),
	z.strictObject({ action: z.literal('billing-revoke'), ...target, reason: text(500), by }).refine(oneTarget),
	z.strictObject({ action: z.literal('billing-grants'), ...target }).refine((v) => v.email === undefined || v.teamId === undefined),
	z.strictObject({
		action: z.literal('billing-report'),
		month: z
			.string()
			.regex(/^\d{4}-(0[1-9]|1[0-2])$/)
			.nullable()
			.optional()
	}),
	z.strictObject({ action: z.literal('authority-confirm'), projectId: uuid, email, reference: text(200) })
]);
export type OwnerAction = z.output<typeof ownerActionSchema>;

export type OwnerActionErrorCode =
	| 'refused'
	| 'no_person'
	| 'no_team'
	| 'no_billing_account'
	| 'live_subscription'
	| 'no_live_grant'
	| 'invalid'
	| 'not_editor'
	| 'action_failed';

const REASONS: Record<OwnerActionErrorCode, string> = {
	refused: 'not a known action, or a field is missing, malformed or unknown (docs/deployment.md § Owner actions)',
	no_person: 'no account has that address',
	no_team: 'no team has that id',
	no_billing_account: 'the account has no billing account, so no grant',
	live_subscription: 'the account has a live subscription: a Stripe one is cancelled in Stripe first; a manual or mock one needs replace',
	no_live_grant: 'the account has no live staff grant',
	invalid: 'the database refused a value (the plan, the end date, the reason or who acts)',
	not_editor: 'the person is not an editor or owner of the project, or the reference is empty',
	action_failed: 'the action failed; the detail is in CloudWatch'
};

/** A refusal or failure with a code and a fixed public reason; `message` is for CloudWatch only. */
export class OwnerActionError extends Error {
	constructor(
		readonly code: OwnerActionErrorCode,
		message = REASONS[code]
	) {
		super(message);
		this.name = 'OwnerActionError';
	}
	get publicReason(): string {
		return REASONS[this.code];
	}
}

/** The event as an action, or an OwnerActionError('refused'). Never echoes a value back. */
export function parseOwnerAction(event: unknown): OwnerAction {
	const r = ownerActionSchema.safeParse(event);
	if (!r.success) throw new OwnerActionError('refused', `refused owner action: ${r.error.issues.map((i) => `${i.path.join('.') || '(event)'} ${i.code}`).join('; ')}`);
	return r.data;
}

/** A database or lookup error as a public code: never its text. */
export function ownerActionCode(err: unknown): OwnerActionErrorCode {
	if (err instanceof OwnerActionError) return err.code;
	if (err instanceof StaffGrantError) return err.code;
	if (err instanceof NoPersonError) return 'no_person';
	switch ((err as { code?: string })?.code) {
		case '23505':
			return 'live_subscription';
		case 'P0002':
			return 'no_live_grant';
		case '22023':
			return 'invalid';
		case '23514':
			return 'not_editor';
		default:
			return 'action_failed';
	}
}

export const ownerActionReason = (code: OwnerActionErrorCode): string => REASONS[code];

const targetOf = (a: { email?: string; teamId?: string }): Target => (a.email !== undefined ? { kind: 'user', email: a.email } : { kind: 'team', teamId: a.teamId! });

export type OwnerActionResult =
	| { action: 'billing-grant'; accountId: string; kind: Target['kind']; plan: string; endsAt: string | null; replaced: boolean }
	| { action: 'billing-revoke'; accountId: string; kind: Target['kind']; plan: string }
	| { action: 'billing-grants'; kind: Target['kind']; accountId: string | null; planNow: string; log: LogRow[] }
	| { action: 'billing-grants'; kind: 'all'; grants: LiveGrant[] }
	| { action: 'billing-report'; report: Report }
	| { action: 'authority-confirm'; projectId: string; userId: string; confirmed: true };

/** Run one parsed action on the schema owner's connection. */
export async function runOwnerAction(client: pg.ClientBase, a: OwnerAction): Promise<OwnerActionResult> {
	switch (a.action) {
		case 'billing-grant': {
			const t = targetOf(a);
			const g = await grantPlan(client, { target: t, plan: a.plan, until: a.until ?? null, reason: a.reason, by: a.by, replace: a.replace ?? false });
			return { action: a.action, accountId: g.accountId, kind: t.kind, plan: g.plan, endsAt: g.endsAt, replaced: g.replaced };
		}
		case 'billing-revoke': {
			const t = targetOf(a);
			const r = await revokeGrant(client, { target: t, reason: a.reason, by: a.by });
			return { action: a.action, accountId: r.accountId, kind: t.kind, plan: r.plan };
		}
		case 'billing-grants': {
			if (a.email === undefined && a.teamId === undefined) return { action: a.action, kind: 'all', grants: await liveGrants(client) };
			const t = targetOf(a);
			return { action: a.action, kind: t.kind, ...(await grantLog(client, t)) };
		}
		case 'billing-report':
			// Never the addresses: the script's default (no --show-emails), always.
			return { action: a.action, report: redact(await gatherReportOn(client, a.month ?? null)) };
		case 'authority-confirm': {
			const { userId } = await confirmAuthorityDelegate(client, a.projectId, a.email, a.reference);
			return { action: a.action, projectId: a.projectId, userId, confirmed: true };
		}
	}
}
