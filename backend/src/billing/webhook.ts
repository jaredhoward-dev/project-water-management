// POST /billing/webhook/:provider (issue #641 Phase 3, docs/api.md § Billing,
// docs/billing.md § Webhooks and providers). Public: the provider's signature
// over the raw body is the credential (routes.test.ts PUBLIC).
//
//   1. :provider must be the configured BILLING_PROVIDER and one that takes
//      webhooks (not manual), else 404: a different provider's payload can't be checked.
//   2. The raw body, capped at WEBHOOK_BODY_MAX, read once as text: the signature is
//      over these exact bytes, never a re-serialised JSON.
//   3. Signature and normalisation (provider.ts): 400 on either, with a fixed message.
//   4. app_billing_apply(provider, event id, type, payload) in a transaction with no
//      user (withoutUser, as the job tick's definer calls): never as `water`, never
//      BYPASSRLS. It records the event once (a redelivery is `duplicate`) and is the
//      only writer of subscription status.
//
// Answers, by app_billing_apply's result: applied, recorded, duplicate, stale → 200
// (stale: older than the event last applied to the subscription, 327, so skipped);
// conflict, unknown_account → 200 with a warning logged (a retry wouldn't change
// them, and the operator reads the log); invalid → 400. A type we don't act on is
// 200 without a database call. A database error is the app's 500 (no raw text),
// which Stripe retries. Each answer logs one line: provider, type, event id and
// result, never the payload or the secret.
//
// An orphan (352; docs/billing.md § Deleting an account): a live subscription
// (subscription.updated, trialing/active/past_due) answered unknown_account, or
// a checkout.completed recorded with no account, is a checkout paid after its
// account was deleted. In the same transaction as app_billing_apply the event
// row becomes orphan_pending (app_billing_orphan_claim); then the provider
// cancels the subscription now and refunds its first invoice when that was
// paid within the refund window (cancelOrphan; stripeApi.ts
// ORPHAN_REFUND_WINDOW_SECONDS), the row becomes orphan_refunded
// (app_billing_orphan_done), and the answer is 200 `orphan_refunded`. One
// already ended whose first invoice is older (a late event about a
// subscription its account used) is left alone: `orphan_skipped_old`. Only a
// subscription this deployment sold is touched: checkout stamps
// BILLING_ENVIRONMENT into its metadata (wm_environment), and an event whose
// tag differs or is missing is logged (`orphan: 'other_environment'`) and
// answered as app_billing_apply did. If the cancel or refund fails the answer is 503, so the
// provider redelivers; the redelivery is a duplicate to app_billing_apply, but
// its row is still orphan_pending, so it tries again. Every step is idempotent
// at the provider, so a redelivery (or the session's and the subscription's
// events both) refunds once. Logged like every answer (provider, type, event
// id, result) plus what was done (cancelled, refunds, refundedMinor), or on a
// failure where it stopped (step, Stripe's status and code, the error's class):
// never the payload, an error message, the account or an address.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { withoutUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { billingEnvironment, billingProvider, type NormalisedEvent } from './provider.js';
import { StripeApiError } from './provider/stripeApi.js';
import { SIGNATURE_HEADER } from './provider/signature.js';

/** Stripe's events are a few KB; 256 KiB is far above any real one and far below the app-wide 4 MB. */
export const WEBHOOK_BODY_MAX = 256 * 1024;

export const APPLY_RESULTS = ['applied', 'recorded', 'duplicate', 'stale', 'conflict', 'unknown_account', 'invalid'] as const;
export type ApplyResult = (typeof APPLY_RESULTS)[number];

const LIVE = new Set(['trialing', 'active', 'past_due']);

/**
 * Why cancelling an orphan failed, for the log line: the step (stripeApi.ts OrphanStep) and Stripe's
 * HTTP status and error code, found on the error or the BillingProviderError wrapping it, and the
 * error's class name. Never its message, Stripe's payload or the request.
 */
export function orphanFailure(e: unknown): { step: string | null; status: number | null; code: string | null; error: string | null } {
	const chain = [e, e instanceof Error ? e.cause : undefined];
	const api = chain.find((x): x is StripeApiError => x instanceof StripeApiError);
	const step = chain.map((x) => (typeof x === 'object' && x !== null ? (x as { step?: unknown }).step : undefined)).find((v): v is string => typeof v === 'string');
	const inner = chain.filter((x): x is Error => x instanceof Error).at(-1);
	return { step: step ?? null, status: api?.status ?? null, code: api?.code ?? null, error: inner?.name ?? null };
}

/** The provider's subscription an event would leave charging if its account were gone: a live subscription's, or a completed checkout's. */
export function orphanableRef(event: NormalisedEvent): string | null {
	if (event.type === 'subscription.updated') return LIVE.has(event.payload.status) ? event.payload.externalRef : null;
	if (event.type === 'checkout.completed') return event.payload.externalRef;
	return null;
}

export const billingWebhookRoutes = new Hono().post(
	'/webhook/:provider',
	async (c, next) => {
		// Before the body is read: an unconfigured provider costs nothing.
		const provider = billingProvider();
		if (!provider?.acceptsWebhooks || provider.name !== c.req.param('provider')) return c.json({ error: 'not found' }, 404);
		return next();
	},
	bodyLimit({ maxSize: WEBHOOK_BODY_MAX, onError: (c) => c.json({ error: 'request too large' }, 413) }),
	async (c) => {
		const provider = billingProvider()!;
		const raw = await c.req.text();
		// Only the signature header, the one credential this route reads (token-confusion.security.db.test.ts lists it).
		const headers: Record<string, string | undefined> = { [SIGNATURE_HEADER]: c.req.header(SIGNATURE_HEADER) };
		const verified = provider.verifyAndNormalise(raw, headers);
		if (!verified.ok) {
			logEvent('warn', { event: 'billing_webhook_rejected', provider: provider.name, reason: verified.reason });
			return c.json({ error: verified.reason === 'signature' ? 'invalid signature' : 'invalid event' }, 400);
		}
		if ('ignored' in verified) {
			logEvent('info', { event: 'billing_webhook', provider: provider.name, type: verified.ignored.type, eventId: verified.ignored.eventId, result: 'ignored' });
			return c.json({ received: true, result: 'ignored' });
		}
		const { eventId, type, payload } = verified.event;
		const ref = orphanableRef(verified.event);
		// Only what this deployment sold (checkout's wm_environment): another deployment's subscription on a
		// shared Stripe account, or one with no tag, is never cancelled or refunded from here.
		const ours = ref !== null && verified.event.environment === billingEnvironment();
		const orphanRef = ours ? ref : null;
		const accountGone = (r: string | undefined) => r === (type === 'checkout.completed' ? 'recorded' : 'unknown_account');
		const { result, orphan } = await withoutUser(async (db) => {
			const { rows } = await db.query<{ result: string }>('SELECT app_billing_apply($1, $2, $3, $4::jsonb) AS result', [
				provider.name,
				eventId,
				type,
				JSON.stringify(payload)
			]);
			const result = rows[0]?.result;
			// The account can't be found (first delivery), or an earlier delivery left the orphan pending (a redelivery).
			const candidate = orphanRef !== null && (result === 'duplicate' || accountGone(result));
			if (!candidate) return { result, orphan: false };
			const claim = await db.query<{ claimed: boolean }>('SELECT app_billing_orphan_claim($1, $2, $3) AS claimed', [provider.name, eventId, result !== 'duplicate']);
			return { result, orphan: claim.rows[0]?.claimed === true };
		});
		if (!(APPLY_RESULTS as readonly string[]).includes(result ?? '')) throw new Error('app_billing_apply answered an unknown result');
		if (orphan && orphanRef !== null) {
			let done;
			try {
				done = await provider.cancelOrphan({ accountId: payload.accountId, subscriptionRef: orphanRef });
			} catch (e) {
				// The event stays orphan_pending; a non-2xx makes the provider redeliver it.
				logEvent('error', { event: 'billing_webhook', provider: provider.name, type, eventId, result: 'orphan_failed', ...orphanFailure(e) });
				return c.json({ error: 'the payment provider couldn’t be reached; try again' }, 503);
			}
			const outcome = done.skipped ? 'orphan_skipped_old' : 'orphan_refunded';
			await withoutUser((db) => db.query('SELECT app_billing_orphan_done($1, $2, $3)', [provider.name, eventId, outcome]));
			logEvent('warn', {
				event: 'billing_webhook',
				provider: provider.name,
				type,
				eventId,
				result: outcome,
				cancelled: done.cancelled,
				refunds: done.refunds,
				refundedMinor: done.refundedMinor
			});
			return c.json({ received: true, result: outcome });
		}
		// Would have been an orphan, but another deployment (or none) sold it: logged, nothing done.
		if (ref !== null && !ours && accountGone(result)) {
			logEvent('warn', { event: 'billing_webhook', provider: provider.name, type, eventId, result, orphan: 'other_environment' });
			return c.json({ received: true, result });
		}
		const level = result === 'conflict' || result === 'unknown_account' || result === 'invalid' ? 'warn' : 'info';
		logEvent(level, { event: 'billing_webhook', provider: provider.name, type, eventId, result });
		if (result === 'invalid') return c.json({ error: 'invalid event' }, 400);
		return c.json({ received: true, result });
	}
);
