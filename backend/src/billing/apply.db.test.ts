// The billing webhook's SQL (326_billing_events.sql, issue #641 Phase 3): app_billing_apply, the only writer of
// subscription status, called with no user as water_app (withoutUser), and billing_event's de-duplication.
//  - an event applies once; its replay is a duplicate and changes nothing;
//  - created → updated → deleted moves the status, and an ended subscription stays ended;
//  - a second live subscription under another external_ref, or a ref moving accounts, is a conflict and changes nothing;
//  - an unknown account and an invalid payload are answered, never raised; an invalid event isn't recorded;
//  - water_app can't write subscription or billing_event, nor read billing_event; the function refuses a user's session.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
let person: User;
let other: User;
let account: string;
let otherAccount: string;

const apply = (type: string, payload: unknown, eventId = `evt_${randomUUID()}`, provider = 'mock') =>
	withoutUser(
		async (db) =>
			(await db.query<{ r: string }>('SELECT app_billing_apply($1, $2, $3, $4::jsonb) AS r', [provider, eventId, type, JSON.stringify(payload)]))
				.rows[0]!.r
	);
const subs = async (acct: string) =>
	(await asOwner(
		'SELECT external_ref, plan_code, status, seats, cancel_at_period_end, trial_end FROM subscription WHERE billing_account_id = $1 ORDER BY created_at, external_ref',
		[acct]
	)) as { external_ref: string; plan_code: string; status: string; seats: number; cancel_at_period_end: boolean; trial_end: Date | null }[];
const event = async (eventId: string) =>
	((await asOwner('SELECT type, outcome, account_id FROM billing_event WHERE provider = $1 AND event_id = $2', ['mock', eventId])) as {
		type: string;
		outcome: string;
		account_id: string | null;
	}[])[0];
const payload = (acct: string, ref: string, over: Record<string, unknown> = {}) => ({
	accountId: acct,
	planCode: 'pro',
	status: 'active',
	seats: 1,
	periodStart: '2026-11-01T00:00:00Z',
	periodEnd: '2026-12-01T00:00:00Z',
	trialEnd: null,
	cancelAtPeriodEnd: false,
	externalRef: ref,
	...over
});
const sqlState = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return (e as { code?: string }).code;
	}
};

beforeAll(async () => {
	[person, other] = (await Promise.all(['ApplyPerson', 'ApplyOther'].map((n) => signUp(n)))) as [User, User];
	account = await withUser(person.id, async (db) => (await db.query<{ id: string }>('SELECT app_my_billing_account() AS id')).rows[0]!.id);
	otherAccount = await withUser(other.id, async (db) => (await db.query<{ id: string }>('SELECT app_my_billing_account() AS id')).rows[0]!.id);
});

afterAll(async () => {
	await asOwner('DELETE FROM subscription WHERE billing_account_id = ANY($1)', [[account, otherAccount]]);
	await asOwner('DELETE FROM billing_event WHERE account_id = ANY($1)', [[account, otherAccount]]);
});

describe('app_billing_apply', () => {
	it('applies an event once, with no user, and a replay is a duplicate that changes nothing', async () => {
		const ref = `sub_${randomUUID()}`;
		const id = `evt_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, ref, { planCode: 'pro', seats: 2 }), id)).toBe('applied');
		expect(await subs(account)).toEqual([expect.objectContaining({ external_ref: ref, plan_code: 'pro', status: 'active', seats: 2 })]);
		expect(await event(id)).toEqual({ type: 'subscription.updated', outcome: 'applied', account_id: account });
		// The person now reads their plan as Pro (the subscription is theirs; positive control for the read side).
		expect(
			await withUser(person.id, async (db) => (await db.query('SELECT app_account_plan($1) -> $2 ->> $3 AS v', [account, 'plan', 'code'])).rows[0]!.v)
		).toBe('pro');

		// The same event id again, even carrying another payload: nothing changes.
		expect(await apply('subscription.updated', payload(account, ref, { planCode: 'team', seats: 9 }), id)).toBe('duplicate');
		expect(await subs(account)).toEqual([expect.objectContaining({ plan_code: 'pro', seats: 2 })]);
		// The same id from another provider is another event (provider-keyed).
		expect(await apply('invoice.paid', { accountId: account }, id, 'stripe')).toBe('recorded');

		await apply('subscription.deleted', { accountId: account, externalRef: ref });
	});

	it('moves the status through created, updated and deleted, and an ended subscription stays ended', async () => {
		const ref = `sub_${randomUUID()}`;
		expect(
			await apply('subscription.created', payload(account, ref, { status: 'trialing', trialEnd: '2026-11-15T00:00:00Z', planCode: 'team', seats: 3 }))
		).toBe('applied');
		expect((await subs(account)).find((s) => s.external_ref === ref)).toMatchObject({ status: 'trialing', plan_code: 'team', seats: 3 });

		expect(await apply('subscription.updated', payload(account, ref, { status: 'past_due', planCode: 'team', seats: 4, cancelAtPeriodEnd: true }))).toBe(
			'applied'
		);
		expect((await subs(account)).find((s) => s.external_ref === ref)).toMatchObject({ status: 'past_due', seats: 4, cancel_at_period_end: true });

		const del = `evt_${randomUUID()}`;
		expect(await apply('subscription.deleted', { accountId: account, externalRef: ref }, del)).toBe('applied');
		expect((await subs(account)).find((s) => s.external_ref === ref)).toMatchObject({ status: 'canceled' });
		expect(await event(del)).toMatchObject({ outcome: 'applied' });

		// A late update after the delete (out of order, or a fresh event id replaying old state) doesn't revive it.
		expect(await apply('subscription.updated', payload(account, ref, { status: 'active', planCode: 'team' }))).toBe('conflict');
		expect((await subs(account)).find((s) => s.external_ref === ref)).toMatchObject({ status: 'canceled' });
		// Deleting it again, or deleting a ref we never held, has nothing to apply.
		expect(await apply('subscription.deleted', { accountId: account, externalRef: ref })).toBe('recorded');
		expect(await apply('subscription.deleted', { accountId: account, externalRef: `sub_${randomUUID()}` })).toBe('recorded');
		// The account is back on Free.
		expect(
			await withUser(person.id, async (db) => (await db.query('SELECT app_account_plan($1) -> $2 ->> $3 AS v', [account, 'plan', 'code'])).rows[0]!.v)
		).toBe('free');
	});

	it('refuses a second live subscription under another external_ref, and a ref moving accounts, changing nothing', async () => {
		const live = `sub_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, live))).toBe('applied');
		const before = await subs(account);

		const second = `evt_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, `sub_${randomUUID()}`, { planCode: 'team' }), second)).toBe('conflict');
		expect(await subs(account)).toEqual(before);
		expect(await event(second)).toMatchObject({ outcome: 'conflict', account_id: account });
		// Recorded, so the provider's retry of the same event is a duplicate, not a second conflict.
		expect(await apply('subscription.updated', payload(account, `sub_${randomUUID()}`), second)).toBe('duplicate');

		// A non-live row under another ref is fine (positive control: the guard is about live rows only).
		expect(await apply('subscription.updated', payload(account, `sub_${randomUUID()}`, { status: 'expired' }))).toBe('applied');

		// The live ref named for another account: neither account changes.
		const otherBefore = await subs(otherAccount);
		expect(await apply('subscription.updated', payload(otherAccount, live))).toBe('conflict');
		expect(await apply('subscription.deleted', { accountId: otherAccount, externalRef: live })).toBe('conflict');
		expect(await subs(otherAccount)).toEqual(otherBefore);
		expect((await subs(account)).find((s) => s.external_ref === live)).toMatchObject({ status: 'active' });

		await apply('subscription.deleted', { accountId: account, externalRef: live });
	});

	it('answers an unknown account, recording the event without an account', async () => {
		const id = `evt_${randomUUID()}`;
		const ghost = randomUUID();
		expect(await apply('subscription.updated', payload(ghost, `sub_${randomUUID()}`), id)).toBe('unknown_account');
		expect(await event(id)).toEqual({ type: 'subscription.updated', outcome: 'unknown_account', account_id: null });
		expect(await asOwner('SELECT 1 FROM subscription WHERE billing_account_id = $1', [ghost])).toEqual([]);
		expect(await apply('subscription.updated', payload(ghost, `sub_${randomUUID()}`), id)).toBe('duplicate');
		// A record-only type naming an unknown account is just recorded.
		expect(await apply('invoice.payment_failed', { accountId: ghost })).toBe('recorded');
	});

	it('answers an invalid payload with invalid, records nothing, and lets the corrected retry apply', async () => {
		const ref = `sub_${randomUUID()}`;
		const before = await subs(account);
		const bad: [string, unknown][] = [
			['not an object', 'pro'],
			['no account', { ...payload(account, ref), accountId: undefined }],
			['account not a uuid', payload('acct_1', ref)],
			['no externalRef', { ...payload(account, ref), externalRef: undefined }],
			['empty externalRef', payload(account, '')],
			['unknown plan', payload(account, ref, { planCode: 'enterprise' })],
			['unknown status', payload(account, ref, { status: 'paused' })],
			['seats zero', payload(account, ref, { seats: 0 })],
			['seats fractional', payload(account, ref, { seats: 1.5 })],
			['seats a string', payload(account, ref, { seats: '2' })],
			['bad timestamp', payload(account, ref, { periodStart: 'yesterday' })],
			['infinite timestamp', payload(account, ref, { periodEnd: 'infinity' })],
			['no offset', payload(account, ref, { periodStart: '2026-11-01T00:00:00' })],
			['impossible date', payload(account, ref, { periodEnd: '2026-02-30T00:00:00Z' })],
			['period ends before it starts', payload(account, ref, { periodEnd: '2026-10-01T00:00:00Z' })],
			['bad trialEnd', payload(account, ref, { trialEnd: 12 })],
			['cancelAtPeriodEnd a string', payload(account, ref, { cancelAtPeriodEnd: 'false' })]
		];
		for (const [why, p] of bad) {
			const id = `evt_${randomUUID()}`;
			expect(await apply('subscription.updated', p, id), why).toBe('invalid');
			expect(await event(id), why).toBeUndefined();
		}
		expect(await apply('subscription.deleted', { accountId: account })).toBe('invalid');
		expect(await apply('subscription.updated', null)).toBe('invalid');
		// Bad arguments: an unknown provider, an empty event id, an empty type.
		expect(await apply('subscription.updated', payload(account, ref), `evt_${randomUUID()}`, 'paypal')).toBe('invalid');
		expect(await apply('subscription.updated', payload(account, ref), '')).toBe('invalid');
		expect(await apply('', payload(account, ref))).toBe('invalid');
		expect(await subs(account)).toEqual(before);

		// The provider retries a refused event under the same id; corrected, it applies (it wasn't recorded as seen).
		const id = `evt_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, ref, { seats: 0 }), id)).toBe('invalid');
		expect(await apply('subscription.updated', payload(account, ref), id)).toBe('applied');
		await apply('subscription.deleted', { accountId: account, externalRef: ref });
	});

	it('records other event types without touching subscriptions', async () => {
		const before = await subs(account);
		const id = `evt_${randomUUID()}`;
		expect(await apply('invoice.paid', { accountId: account, amount: 89900 }, id)).toBe('recorded');
		expect(await event(id)).toEqual({ type: 'invoice.paid', outcome: 'recorded', account_id: account });
		expect(await apply('checkout.session.completed', 'anything')).toBe('recorded');
		expect(await subs(account)).toEqual(before);
	});

	it('refuses to run inside a signed-in user’s transaction', async () => {
		expect(
			await sqlState(
				withUser(person.id, (db) =>
					db.query('SELECT app_billing_apply($1, $2, $3, $4::jsonb)', ['mock', `evt_${randomUUID()}`, 'subscription.updated', JSON.stringify(payload(account, 'x'))])
				)
			)
		).toBe('42501');
	});
});

describe('billing_event and subscription are closed to water_app', () => {
	it('cannot write subscription or billing_event, nor read billing_event, with or without a user', async () => {
		const attempts = [
			`INSERT INTO subscription (billing_account_id, plan_code, status, provider, external_ref) VALUES ('${account}', 'team', 'active', 'mock', 'direct')`,
			`UPDATE subscription SET status = 'active' WHERE billing_account_id = '${account}'`,
			`DELETE FROM subscription WHERE billing_account_id = '${account}'`,
			`INSERT INTO billing_event (provider, event_id, type, outcome) VALUES ('mock', 'direct', 'subscription.updated', 'recorded')`,
			`UPDATE billing_event SET outcome = 'applied'`,
			`DELETE FROM billing_event`,
			`SELECT * FROM billing_event`
		];
		for (const sql of attempts) {
			expect(await sqlState(withoutUser((db) => db.query(sql))), sql).toBe('42501');
			expect(await sqlState(withUser(person.id, (db) => db.query(sql))), sql).toBe('42501');
		}
		// Positive control: water_app reads its own subscriptions through RLS.
		const ref = `sub_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, ref))).toBe('applied');
		const seen = await withUser(person.id, async (db) => (await db.query('SELECT external_ref FROM subscription WHERE external_ref = $1', [ref])).rows);
		expect(seen).toEqual([{ external_ref: ref }]);
		// …and another person can't (negative control).
		expect(await withUser(other.id, async (db) => (await db.query('SELECT 1 FROM subscription WHERE external_ref = $1', [ref])).rows)).toEqual([]);
		await apply('subscription.deleted', { accountId: account, externalRef: ref });
	});
});
