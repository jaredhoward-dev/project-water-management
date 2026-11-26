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
//   billing-account    src/billing/staffGrant.ts lookupAccount (the ids the workflow takes; direct invoke only)
//   billing-invoice    src/billing/invoice.ts issueInvoice     (pnpm dev:billing:invoice; direct invoke only: a PO number may identify a client)
//
// Ids, never addresses, from the workflow. Its runs are in a public repo, and
// we can't rule out GitHub showing a run's workflow_dispatch inputs (its page,
// the API, a later change), so a person's address must never be one. The
// workflow names a billing account, a person, a team or a project by id and
// marks its payload `via: "workflow"`, which this schema holds to ids only:
// an `email` field, or the billing-account lookup, is refused. The address
// forms (and the lookup that turns an address into the ids) are for the
// operator's own `aws lambda invoke` from their SSO session, which never
// touches GitHub (docs/deployment.md § Owner actions).
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
import { grantLog, grantPlan, isCalendarDate, liveGrants, lookupAccount, revokeGrant, StaffGrantError, type LiveGrant, type LogRow, type Owner, type Target } from '../billing/staffGrant.js';
import { confirmAuthorityDelegate, NoPersonError } from '../projects/authorityConfirm.js';
import { InvoiceError, issueInvoice, MAX_INVOICE_SEATS, PO_NUMBER } from '../billing/invoice.js';
import { BillingUnavailableError, BillingProviderError, type BillingProvider } from '../billing/provider.js';

export const OWNER_ACTIONS = ['billing-grant', 'billing-revoke', 'billing-grants', 'billing-report', 'authority-confirm', 'billing-account', 'billing-invoice'] as const;
/** What the billing-admin workflow may send (scripts/release/owner-action.mjs WORKFLOW_ACTIONS): every action but the address lookup and the invoice (its PO number may identify a client). */
export const WORKFLOW_ACTIONS = ['billing-grants', 'billing-grant', 'billing-revoke', 'billing-report', 'authority-confirm'] as const;
/** The most seats a staff grant gives (app_staff_grant_plan's bound, migration 374). */
export const MAX_GRANT_SEATS = 100000;
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

/** Who: a person by address (direct invoke only) or id, a team by id, or the billing account by id. */
const target = { email: email.optional(), userId: uuid.optional(), teamId: uuid.optional(), accountId: uuid.optional() };
type TargetFields = { email?: string; userId?: string; teamId?: string; accountId?: string };
const targetCount = (v: TargetFields) => [v.email, v.userId, v.teamId, v.accountId].filter((x) => x !== undefined).length;
const oneTarget = (v: TargetFields) => targetCount(v) === 1;
const atMostOneTarget = (v: TargetFields) => targetCount(v) <= 1;
/** The billing-admin workflow marks its payloads; absent on the operator's direct invoke. */
const via = z.literal('workflow').optional();

export const ownerActionSchema = z.discriminatedUnion('action', [
	z
		.strictObject({
			action: z.literal('billing-grant'),
			via,
			...target,
			plan: z.enum(['pro', 'team']),
			until: day.nullable().optional(),
			reason: text(500),
			by,
			replace: z.boolean().optional(),
			// Editor seats in all (374), as `--seats n` takes them: a whole number, at least 1; absent or null is the
			// plan's included seats. The database refuses fewer than included, extra seats on Pro, and more than
			// MAX_GRANT_SEATS (app_staff_grant_plan), which this bound repeats so a typo fails before anything connects.
			seats: z.number().int().min(1).max(MAX_GRANT_SEATS).nullable().optional()
		})
		.refine(oneTarget),
	z.strictObject({ action: z.literal('billing-revoke'), via, ...target, reason: text(500), by }).refine(oneTarget),
	z.strictObject({ action: z.literal('billing-grants'), via, ...target }).refine(atMostOneTarget),
	z.strictObject({
		action: z.literal('billing-report'),
		via,
		month: z
			.string()
			.regex(/^\d{4}-(0[1-9]|1[0-2])$/)
			.nullable()
			.optional()
	}),
	z
		.strictObject({ action: z.literal('authority-confirm'), via, projectId: uuid, email: email.optional(), userId: uuid.optional(), reference: text(200) })
		.refine((v) => (v.email === undefined) !== (v.userId === undefined)),
	// The lookup is the operator's alone, from their SSO session: no `via`, so the workflow can't send it.
	z
		.strictObject({ action: z.literal('billing-account'), email: email.optional(), userId: uuid.optional(), teamId: uuid.optional() })
		.refine((v) => [v.email, v.userId, v.teamId].filter((x) => x !== undefined).length === 1),
	// The invoice is the operator's alone too: no `via`. A PO number may identify the client, and the workflow's inputs may be public.
	z
		.strictObject({
			action: z.literal('billing-invoice'),
			...target,
			plan: z.enum(['pro', 'team']),
			interval: z.enum(['month', 'year']),
			seats: z.number().int().min(1).max(MAX_INVOICE_SEATS).optional(),
			from: day.nullable().optional(),
			poNumber: z.string().trim().regex(PO_NUMBER)
		})
		.refine(oneTarget)
]).refine((v) => !('via' in v && v.via === 'workflow' && 'email' in v && v.email !== undefined), { message: 'the workflow names people by id, never by address' });
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
	| 'billing_unavailable'
	| 'billing_provider_error'
	| 'action_failed';

const REASONS: Record<OwnerActionErrorCode, string> = {
	refused: 'not a known action, or a field is missing, malformed or unknown (docs/deployment.md § Owner actions)',
	no_person: 'no account has that address or id',
	no_team: 'no team has that id',
	no_billing_account: 'no such billing account, or the account has none, so no grant',
	live_subscription: 'the account has a live subscription: a Stripe one is cancelled in Stripe first; a manual or mock one needs replace',
	no_live_grant: 'the account has no live staff grant',
	invalid: 'the database refused a value (the plan, the seats, the end date, the reason or who acts)',
	not_editor: 'the person is not an editor or owner of the project, or the reference is empty',
	billing_unavailable: 'this function has no billing provider that sends invoices (BILLING_PROVIDER=stripe with its key; docs/deployment.md § Owner actions)',
	billing_provider_error: 'the billing provider failed or refused the invoice; the detail is in CloudWatch',
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
	if (err instanceof InvoiceError) return err.code;
	if (err instanceof BillingUnavailableError) return 'billing_unavailable';
	if (err instanceof BillingProviderError) return 'billing_provider_error';
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

const targetOf = (a: TargetFields): Target =>
	a.email !== undefined
		? { kind: 'user', email: a.email }
		: a.userId !== undefined
			? { kind: 'user', userId: a.userId }
			: a.teamId !== undefined
				? { kind: 'team', teamId: a.teamId }
				: { kind: 'account', accountId: a.accountId! };

export type OwnerActionResult =
	| { action: 'billing-grant'; accountId: string; kind: Owner['kind']; plan: string; seats: number; endsAt: string | null; replaced: boolean }
	| { action: 'billing-revoke'; accountId: string; kind: Owner['kind']; plan: string }
	| { action: 'billing-grants'; kind: Owner['kind']; accountId: string | null; planNow: string; log: LogRow[] }
	| { action: 'billing-grants'; kind: 'all'; grants: LiveGrant[] }
	| { action: 'billing-report'; report: Report }
	| { action: 'authority-confirm'; projectId: string; userId: string; confirmed: true }
	| { action: 'billing-account'; kind: Owner['kind']; ownerId: string; accountId: string | null; planNow: string }
	| {
			action: 'billing-invoice';
			accountId: string;
			kind: Owner['kind'];
			plan: string;
			seats: number;
			interval: 'month' | 'year';
			from: string;
			until: string;
			invoiceId: string;
			number: string | null;
			status: string;
			totalMinor: number;
			dueAt: string | null;
			reused: boolean;
	  };

/** What an action may need beyond the database: the provider that sends invoices (null: none here, so billing-invoice is refused). */
export interface OwnerActionDeps {
	invoiceProvider?: BillingProvider | null;
}

/** Run one parsed action on the schema owner's connection. */
export async function runOwnerAction(client: pg.ClientBase, a: OwnerAction, deps: OwnerActionDeps = {}): Promise<OwnerActionResult> {
	switch (a.action) {
		case 'billing-grant': {
			const t = targetOf(a);
			const g = await grantPlan(client, { target: t, plan: a.plan, until: a.until ?? null, reason: a.reason, by: a.by, replace: a.replace ?? false, seats: a.seats ?? null });
			return { action: a.action, accountId: g.accountId, kind: g.kind, plan: g.plan, seats: g.seats, endsAt: g.endsAt, replaced: g.replaced };
		}
		case 'billing-revoke': {
			const t = targetOf(a);
			const r = await revokeGrant(client, { target: t, reason: a.reason, by: a.by });
			return { action: a.action, accountId: r.accountId, kind: r.kind, plan: r.plan };
		}
		case 'billing-grants': {
			if (targetCount(a) === 0) return { action: a.action, kind: 'all', grants: await liveGrants(client) };
			return { action: a.action, ...(await grantLog(client, targetOf(a))) };
		}
		case 'billing-report':
			// Never the addresses: the script's default (no --show-emails), always.
			return { action: a.action, report: redact(await gatherReportOn(client, a.month ?? null)) };
		case 'authority-confirm': {
			const person = a.email !== undefined ? { email: a.email } : { userId: a.userId! };
			const { userId } = await confirmAuthorityDelegate(client, a.projectId, person, a.reference);
			return { action: a.action, projectId: a.projectId, userId, confirmed: true };
		}
		case 'billing-account': {
			const { kind, ownerId, accountId, planNow } = await lookupAccount(client, targetOf(a));
			return { action: a.action, kind, ownerId, accountId, planNow };
		}
		case 'billing-invoice': {
			const provider = deps.invoiceProvider ?? null;
			if (!provider) throw new OwnerActionError('billing_unavailable');
			// The PO number goes to the provider only; the answer leaves it out (the operator has it).
			const r = await issueInvoice(client, provider, { target: targetOf(a), plan: a.plan, interval: a.interval, seats: a.seats, from: a.from ?? null, poNumber: a.poNumber });
			const { invoiceId, number, status, totalMinor, dueAt, reused } = r.invoice;
			return { action: a.action, accountId: r.accountId, kind: r.kind, plan: r.plan, seats: r.seats, interval: r.interval, from: r.from, until: r.until, invoiceId, number, status, totalMinor, dueAt, reused };
		}
	}
}
