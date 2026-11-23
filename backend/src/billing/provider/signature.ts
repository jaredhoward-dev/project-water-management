// Stripe's webhook signature scheme (`Stripe-Signature: t=<unix seconds>,v1=<hex>`),
// checked with node:crypto alone: no `stripe` package (issue #641 Phase 3,
// docs/billing.md § Webhooks and providers). The mock provider signs the same
// way with the committed dev-only key, so one check serves both.
//
// Ported from threkir's `_shared/webhook_security.ts` (verifyTimestampedHmac):
//   - the signed payload is `${t}.${rawBody}` over the RAW body, never a
//     re-serialised JSON;
//   - `t` must be digits only, and the payload is built from the header TEXT,
//     so `t=+1700000000`, `t=1700000000junk` and a zero-padded `t` all fail;
//   - every v1 value is tried (Stripe sends two during a secret rotation);
//     v0 and unknown keys are ignored;
//   - freshness both ways: a stale (replayed) or far-future `t` fails, the
//     half feohledger's billing doc records once being missed.
// Here the compare is node:crypto's timingSafeEqual over equal-length buffers.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stripe's default tolerance, and the one its docs recommend. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The header both providers sign in (lower-case, as Hono reads headers). */
export const SIGNATURE_HEADER = 'stripe-signature';

const hmacHex = (secret: string, payload: string) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

/** A `t=…,v1=…` header for `rawBody` at `timestamp` (unix seconds): the mock's sender and the tests. */
export function signPayload(secret: string, rawBody: string, timestamp: number): string {
	const t = String(Math.floor(timestamp));
	return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`;
}

/** Whether `header` signs `rawBody` with `secret`, within `toleranceSec` of `nowMs`. Fails closed on anything missing. */
export function verifySignature(
	rawBody: string,
	header: string | undefined | null,
	secret: string | undefined,
	nowMs: number,
	toleranceSec = SIGNATURE_TOLERANCE_SECONDS
): boolean {
	if (!header || !secret) return false;
	let t: string | null = null;
	const v1: string[] = [];
	for (const part of header.split(',')) {
		const i = part.indexOf('=');
		if (i === -1) continue;
		const key = part.slice(0, i).trim();
		const value = part.slice(i + 1).trim();
		if (key === 't' && /^\d{1,12}$/.test(value)) t = value;
		else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) v1.push(value);
	}
	if (t === null || !v1.length) return false;
	if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
	const expected = Buffer.from(hmacHex(secret, `${t}.${rawBody}`), 'hex');
	// Every candidate is compared (no early exit), each in constant time; the lengths are fixed at 32 bytes by the regex above.
	let ok = false;
	for (const candidate of v1) ok = timingSafeEqual(Buffer.from(candidate, 'hex'), expected) || ok;
	return ok;
}
