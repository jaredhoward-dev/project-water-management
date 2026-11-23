// Stripe's t=…,v1=… signature check (signature.ts): the cases threkir's
// webhook_security tests pin, ported to node:crypto.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from './signature.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
const BODY = '{"id":"evt_1","type":"invoice.paid"}';
const NOW = 1_800_000_000_000;
const T = NOW / 1000;
const hex = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');

describe('verifySignature', () => {
	it('accepts a good signature, and one up to 300 s old or ahead (positive controls)', () => {
		expect(verifySignature(BODY, signPayload(SECRET, BODY, T), SECRET, NOW)).toBe(true);
		expect(verifySignature(BODY, signPayload(SECRET, BODY, T - 300), SECRET, NOW)).toBe(true);
		expect(verifySignature(BODY, signPayload(SECRET, BODY, T + 300), SECRET, NOW)).toBe(true);
	});

	it('matches Stripe’s own construction: HMAC-SHA256 over "<t>.<raw body>"', () => {
		expect(signPayload(SECRET, BODY, T)).toBe(`t=${T},v1=${hex(SECRET, `${T}.${BODY}`)}`);
	});

	it('refuses a tampered body, even by one space (the raw bytes are signed, not the JSON)', () => {
		const header = signPayload(SECRET, BODY, T);
		expect(verifySignature(BODY.replace('invoice.paid', 'invoice.payme'), header, SECRET, NOW)).toBe(false);
		expect(verifySignature(`${BODY} `, header, SECRET, NOW)).toBe(false);
		expect(verifySignature(JSON.stringify(JSON.parse(BODY), null, 1), header, SECRET, NOW)).toBe(false);
	});

	it('refuses a stale or far-future timestamp (a replay)', () => {
		expect(verifySignature(BODY, signPayload(SECRET, BODY, T - 301), SECRET, NOW)).toBe(false);
		expect(verifySignature(BODY, signPayload(SECRET, BODY, T + 301), SECRET, NOW)).toBe(false);
	});

	it('refuses the wrong secret, and no secret at all', () => {
		const header = signPayload(SECRET, BODY, T);
		expect(verifySignature(BODY, header, `${SECRET}x`, NOW)).toBe(false);
		expect(verifySignature(BODY, header, '', NOW)).toBe(false);
		expect(verifySignature(BODY, header, undefined, NOW)).toBe(false);
	});

	it('accepts any one of several v1 values (a secret rotation) and ignores v0', () => {
		const good = hex(SECRET, `${T}.${BODY}`);
		const other = hex('old-secret', `${T}.${BODY}`);
		expect(verifySignature(BODY, `t=${T},v1=${other},v1=${good}`, SECRET, NOW)).toBe(true);
		expect(verifySignature(BODY, `t=${T},v1=${good},v1=${other}`, SECRET, NOW)).toBe(true);
		expect(verifySignature(BODY, `t=${T},v0=${good}`, SECRET, NOW)).toBe(false);
		expect(verifySignature(BODY, `t=${T},v1=${other},v0=${good}`, SECRET, NOW)).toBe(false);
	});

	it('refuses a missing or malformed header, and a timestamp that is not plain digits', () => {
		const good = hex(SECRET, `${T}.${BODY}`);
		for (const header of [undefined, null, '', `v1=${good}`, `t=${T}`, `t=${T},v1=zz`, `t=${T},v1=${good.slice(2)}`]) expect(verifySignature(BODY, header, SECRET, NOW), String(header)).toBe(false);
		// +T and T with junk would parse to the same number; the signed text is the header's, so neither verifies.
		expect(verifySignature(BODY, `t=+${T},v1=${hex(SECRET, `+${T}.${BODY}`)}`, SECRET, NOW)).toBe(false);
		expect(verifySignature(BODY, `t=${T}junk,v1=${good}`, SECRET, NOW)).toBe(false);
		expect(verifySignature(BODY, `t=0${T},v1=${good}`, SECRET, NOW)).toBe(false);
	});
});
