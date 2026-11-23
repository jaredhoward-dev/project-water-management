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
// Answers, by app_billing_apply's result: applied, recorded, duplicate → 200;
// conflict, unknown_account → 200 with a warning logged (a retry wouldn't change
// them, and the operator reads the log); invalid → 400. A type we don't act on is
// 200 without a database call. A database error is the app's 500 (no raw text),
// which Stripe retries. Each answer logs one line: provider, type, event id and
// result, never the payload or the secret.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { withoutUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { billingProvider } from './provider.js';
import { SIGNATURE_HEADER } from './provider/signature.js';

/** Stripe's events are a few KB; 256 KiB is far above any real one and far below the app-wide 4 MB. */
export const WEBHOOK_BODY_MAX = 256 * 1024;

export const APPLY_RESULTS = ['applied', 'recorded', 'duplicate', 'conflict', 'unknown_account', 'invalid'] as const;
export type ApplyResult = (typeof APPLY_RESULTS)[number];

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
		const result = await withoutUser(async (db) => {
			const { rows } = await db.query<{ result: string }>('SELECT app_billing_apply($1, $2, $3, $4::jsonb) AS result', [
				provider.name,
				eventId,
				type,
				JSON.stringify(payload)
			]);
			return rows[0]?.result;
		});
		if (!(APPLY_RESULTS as readonly string[]).includes(result ?? '')) throw new Error('app_billing_apply answered an unknown result');
		const level = result === 'conflict' || result === 'unknown_account' || result === 'invalid' ? 'warn' : 'info';
		logEvent(level, { event: 'billing_webhook', provider: provider.name, type, eventId, result });
		if (result === 'invalid') return c.json({ error: 'invalid event' }, 400);
		return c.json({ received: true, result });
	}
);
