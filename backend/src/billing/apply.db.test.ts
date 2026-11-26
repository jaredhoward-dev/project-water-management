// The billing webhook's SQL (326_billing_events.sql, issue #641 Phase 3): app_billing_apply, the only writer of
// subscription status, called with no user as water_app (withoutUser), and billing_event's de-duplication.
//  - an event applies once; its replay is a duplicate and changes nothing;
//  - created → updated → deleted moves the status, and an ended subscription stays ended;
//  - a second live subscription under another external_ref, or a ref moving accounts, is a conflict and changes nothing;
//  - an unknown account and an invalid payload are answered, never raised; an invalid event isn't recorded;
//  - water_app can't write subscription or billing_event, nor read billing_event; the function refuses a user's session.
//  - 327: an update older (by eventCreated) than the one applied is stale and changes nothing; an equal time, a missing
//    time and a delete apply; the tick purges billing_event rows past BILLING_EVENT_RETENTION_DAYS, and only those.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { BILLING_EVENT_RETENTION_DAYS, runTick } from '../jobs/runner.js';

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

	it('a delete that arrives before the subscription’s first event keeps it from ever going live (399)', async () => {
		// Stripe sent created (t=0), then deleted (t=10); the delete lands first, for a ref never seen.
		const ref = `sub_${randomUUID()}`;
		const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, s)).toISOString();
		const del = `evt_${randomUUID()}`;
		expect(await apply('subscription.deleted', { accountId: account, externalRef: ref, eventCreated: at(10) }, del)).toBe('recorded');
		// The late created (and a later-timed update, a replay of old state under a fresh id): never a live row.
		expect(await apply('subscription.created', payload(account, ref, { eventCreated: at(0) }))).toBe('conflict');
		expect(await apply('subscription.updated', payload(account, ref, { status: 'past_due', eventCreated: at(20) }))).toBe('conflict');
		expect((await subs(account)).filter((s) => s.external_ref === ref)).toEqual([]);
		expect(
			await withUser(person.id, async (db) => (await db.query('SELECT app_account_plan($1) -> $2 ->> $3 AS v', [account, 'plan', 'code'])).rows[0]!.v)
		).toBe('free');
		// An ended status for that ref still records it (nothing live), and another ref is untouched by the delete.
		expect(await apply('subscription.updated', payload(account, ref, { status: 'canceled', eventCreated: at(30) }))).toBe('applied');
		expect((await subs(account)).filter((s) => s.external_ref === ref)).toEqual([expect.objectContaining({ status: 'canceled' })]);
		const fresh = `sub_${randomUUID()}`;
		expect(await apply('subscription.created', payload(account, fresh, { eventCreated: at(0) }))).toBe('applied');
		await apply('subscription.deleted', { accountId: account, externalRef: fresh });
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

	it('skips an update older than the one applied as stale, so the newer state stands (327)', async () => {
		const ref = `sub_${randomUUID()}`;
		const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 12, 0, s)).toISOString();
		const mine = async () => (await subs(account)).filter((r) => r.external_ref === ref);
		const lastEventAt = async () =>
			((await asOwner('SELECT last_event_at FROM subscription WHERE external_ref = $1', [ref])) as { last_event_at: Date | null }[])[0]!.last_event_at?.toISOString();
		// Stripe sent active (t=0), then past_due (t=10); they arrive the other way round.
		const newer = `evt_${randomUUID()}`;
		const older = `evt_${randomUUID()}`;
		expect(await apply('subscription.updated', payload(account, ref, { status: 'past_due', seats: 3, eventCreated: at(10) }), newer)).toBe('applied');
		expect(await apply('subscription.updated', payload(account, ref, { status: 'active', seats: 1, eventCreated: at(0) }), older)).toBe('stale');
		expect(await mine()).toEqual([expect.objectContaining({ external_ref: ref, status: 'past_due', seats: 3 })]);
		expect(await lastEventAt()).toBe(at(10));
		// Recorded with its outcome, so its redelivery is a duplicate.
		expect(await event(older)).toEqual({ type: 'subscription.updated', outcome: 'stale', account_id: account });
		expect(await apply('subscription.updated', payload(account, ref, { status: 'active', seats: 1, eventCreated: at(0) }), older)).toBe('duplicate');

		// An equal time applies, in arrival order (Stripe's created is whole seconds).
		expect(await apply('subscription.updated', payload(account, ref, { status: 'past_due', seats: 4, eventCreated: at(10) }))).toBe('applied');
		expect(await apply('subscription.updated', payload(account, ref, { status: 'active', seats: 5, eventCreated: at(20) }))).toBe('applied');
		expect(await mine()).toEqual([expect.objectContaining({ status: 'active', seats: 5 })]);
		expect(await lastEventAt()).toBe(at(20));

		// No time (an older sender, the mock): applies in arrival order and leaves the time as it was; null the same.
		expect(await apply('subscription.updated', payload(account, ref, { seats: 6 }))).toBe('applied');
		expect(await apply('subscription.updated', payload(account, ref, { seats: 7, eventCreated: null }))).toBe('applied');
		expect(await mine()).toEqual([expect.objectContaining({ status: 'active', seats: 7 })]);
		expect(await lastEventAt()).toBe(at(20));
		// …and a timed update older than the kept time is still stale after them.
		expect(await apply('subscription.updated', payload(account, ref, { seats: 8, eventCreated: at(15) }))).toBe('stale');
		expect(await mine()).toEqual([expect.objectContaining({ seats: 7 })]);

		// A malformed time is invalid and records nothing.
		for (const bad of ['yesterday', '2026-11-20 12:00:00', 1795000000, true]) {
			const id = `evt_${randomUUID()}`;
			expect(await apply('subscription.updated', payload(account, ref, { eventCreated: bad }), id), String(bad)).toBe('invalid');
			expect(await event(id)).toBeUndefined();
		}

		// A delete is never stale, even timed before the kept time; the time stays the newest.
		expect(await apply('subscription.deleted', { accountId: account, externalRef: ref, eventCreated: at(5) })).toBe('applied');
		expect(await mine()).toEqual([expect.objectContaining({ external_ref: ref, status: 'canceled' })]);
		expect(await lastEventAt()).toBe(at(20));
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

describe('billing_event purge (327)', () => {
	const purge = (days: number) =>
		withoutUser(async (db) => (await db.query<{ n: number }>('SELECT app_purge_billing_events(make_interval(days => $1)) AS n', [days])).rows[0]!.n);
	const kept = async (eventId: string) => (await asOwner('SELECT 1 FROM billing_event WHERE provider = $1 AND event_id = $2', ['mock', eventId])).length;

	it('keeps an event past the redelivery window, then the tick deletes it after BILLING_EVENT_RETENTION_DAYS', async () => {
		expect(BILLING_EVENT_RETENTION_DAYS).toBeGreaterThanOrEqual(4);
		expect(await sqlState(purge(3))).toBe('22023');
		const [old, young] = [`evt_${randomUUID()}`, `evt_${randomUUID()}`];
		await asOwner(
			`INSERT INTO billing_event (provider, event_id, type, outcome, account_id, received_at) VALUES
				('mock', $1, 'invoice.paid', 'recorded', $3, now() - make_interval(days => $4 + 1)),
				('mock', $2, 'invoice.paid', 'recorded', $3, now() - make_interval(days => $4 - 1))`,
			[old, young, account, BILLING_EVENT_RETENTION_DAYS]
		);
		const tick = await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
		expect(tick.billingEventsPurged).toBeGreaterThanOrEqual(1);
		expect(await kept(old)).toBe(0);
		// Positive control: one inside the retention stays.
		expect(await kept(young)).toBe(1);
	});

	it('runs only in the worker’s context, never a signed-in user’s', async () => {
		expect(await sqlState(withUser(person.id, (db) => db.query("SELECT app_purge_billing_events(interval '90 days')")))).toBe('42501');
	});
});
