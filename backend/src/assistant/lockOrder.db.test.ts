// The assistant metering's lock order (364_assistant_lock_order; docs/billing.md § The counters). 361's triggers
// take one deployment-wide counter lock before they touch a counter, so every transaction that can wait for it
// must take it before any row a charge or a begin also writes, and any parent row (project, billing account,
// person) it locks against a foreign key check must be locked before it. Each case here runs two transactions
// on their own connections in the order that deadlocked before 364, watching pg_stat_activity for the waits, and
// expects both to commit. A deadlock would fail one of them with 40P01 after deadlock_timeout.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
const PRICE = 2.5;

/** A connection with a transaction open: the schema owner, or water_app signed in as a person (as withUser). */
async function open(as?: User) {
	const c = new pg.Client({ connectionString: as ? process.env.DATABASE_URL : process.env.TEST_MIGRATION_DATABASE_URL });
	await c.connect();
	await c.query('BEGIN');
	if (as) await c.query("SELECT set_config('app.current_user_id', $1, true)", [as.id]);
	return c;
}
const pidOf = (c: pg.Client) => (c as unknown as { processID: number }).processID;

/** Waits until the connection's backend is waiting on a lock, and says which kind. */
async function waitingOn(c: pg.Client): Promise<string | null> {
	for (let i = 0; i < 200; i++) {
		const [r] = await asOwner(
			`SELECT l.locktype FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
			 WHERE a.pid = $1 AND a.wait_event_type = 'Lock'`,
			[pidOf(c)]
		);
		if (r) return r.locktype as string;
		await new Promise((res) => setTimeout(res, 25));
	}
	return null;
}
/** Whether the connection holds the counter lock (assistant_counter_lock: an advisory lock on hashtext('assistant_counter:all')). */
const holdsCounter = async (c: pg.Client) =>
	(
		await asOwner(
			`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted
			 AND objid = (hashtext('assistant_counter:all')::bigint & 4294967295)::oid`,
			[pidOf(c)]
		)
	).length > 0;

async function begin(u: User, pid: string) {
	return withUser(u.id, async (db) => {
		const { rows } = await db.query(
			`SELECT outcome, reservation_id FROM app_assistant_begin($1, 1000000000, 1000, 1000000000, 10000000000000, 150000, 1000, 300, $2, 300000, 20, 1000000000000000)`,
			[pid, PRICE]
		);
		expect(rows[0].outcome).toBe('ok');
		return rows[0].reservation_id as string;
	});
}
const chargeOn = (c: pg.Client, pid: string, reservation: string | null, usd: number) =>
	c.query('SELECT * FROM app_assistant_charge($1, $2, 1000, 100, 0, 0, $3)', [pid, reservation, usd]);
const account = async (pid: string) => (await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid]))[0]!.a as string;

/** Ends every connection, rolling back whatever a failed case left open. */
async function end(...cs: pg.Client[]) {
	await Promise.all(cs.map((c) => c.query('ROLLBACK').catch(() => {})));
	await Promise.all(cs.map((c) => c.end()));
}

describe('a begin that settles an expired reservation, against a charge in flight on its own usage row', () => {
	let owner: User;
	let other: User;
	let projectId: string;
	let otherProject: string;

	beforeAll(async () => {
		[owner, other] = (await Promise.all(['Lowner', 'Lother'].map((n) => signUp(n)))) as [User, User];
		projectId = (await owner.call('POST', '/projects', { name: 'Lock order' })).body.project.id;
		otherProject = (await other.call('POST', '/projects', { name: 'Lock order, other' })).body.project.id;
	});
	afterAll(async () => {
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = ANY($1)', [[projectId, otherProject]]);
	});

	it('both commit, and the settled reservation and the charge are both counted', async () => {
		// Another person's priced reservation, expired: the begin's settle charges it, and that charge's trigger
		// takes the counter lock (positive control: the account is set, so the trigger counts it).
		const otherAccount = await account(otherProject);
		expect(otherAccount).toBeTruthy();
		// The owner's turn in flight: begun (its usage row exists), not yet charged.
		const reservation = await begin(owner, projectId);
		await asOwner(
			`INSERT INTO assistant_reservation (project_id, user_id, month, day, reserved, reserved_usd_micros, created_at, expires_at)
			 VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, assistant_day_of(now()), 1000, 7000, now() - interval '10 minutes', now() - interval '1 minute')`,
			[otherProject, other.id]
		);

		const hold = await open(); // holds the owner's rate row, pausing the begin after its settle
		const b = await open(owner); // the owner's next begin
		const c = await open(owner); // the charge of the turn in flight
		try {
			await hold.query('SELECT 1 FROM assistant_rate WHERE user_id = $1 FOR UPDATE', [owner.id]);
			const began = b.query(
				`SELECT outcome FROM app_assistant_begin($1, 1000000000, 1000, 1000000000, 10000000000000, 150000, 1000, 300, $2, 300000, 20, 1000000000000000)`,
				[projectId, PRICE]
			);
			began.catch(() => {});
			// The begin has settled (and so holds the counter lock) and waits for the rate row.
			expect(await waitingOn(b)).toMatch(/^(transactionid|tuple)$/);
			expect(await holdsCounter(b)).toBe(true);
			// The charge waits for the counter lock. Before 364 it took it in its usage row's trigger, so it
			// already held that row, which the begin is about to write.
			const charged = chargeOn(c, projectId, reservation, 3000);
			charged.catch(() => {});
			expect(await waitingOn(c)).toBe('advisory');
			await hold.query('COMMIT');
			expect((await began).rows[0].outcome).toBe('ok');
			await b.query('COMMIT');
			await charged;
			await c.query('COMMIT');
		} finally {
			await end(hold, b, c);
		}
		const [usage] = await asOwner(
			`SELECT sum(cost_usd_micros)::float8 AS usd FROM assistant_usage WHERE project_id = $1 AND user_id = $2`,
			[projectId, owner.id]
		);
		expect(usage!.usd).toBe(3000);
		const [settled] = await asOwner(
			`SELECT sum(cost_usd_micros)::float8 AS usd FROM assistant_usage WHERE project_id = $1 AND user_id = $2`,
			[otherProject, other.id]
		);
		expect(settled!.usd).toBe(7000);
	});
});

describe('deleting an account, against a charge on one of its projects', () => {
	it('the charging person deletes their own account: both commit', async () => {
		const [owner, editor] = (await Promise.all(['Downer', 'Deditor'].map((n) => signUp(n)))) as [User, User];
		const projectId = (await owner.call('POST', '/projects', { name: 'Lock order, deletion' })).body.project.id;
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBeLessThan(300);
		// The editor has already spent today, so deleting their day row takes the counter lock (positive control).
		const first = await begin(editor, projectId);
		await withUser(editor.id, (db) => db.query('SELECT * FROM app_assistant_charge($1, $2, 1000, 100, 0, 0, 2000)', [projectId, first]));
		const reservation = await begin(editor, projectId);

		const hold = await open(); // holds the counter lock, so the charge stops at it
		const c = await open(editor);
		const d = await open(editor);
		try {
			await hold.query('SELECT assistant_counter_lock()');
			const charged = chargeOn(c, projectId, reservation, 3000);
			charged.catch(() => {});
			expect(await waitingOn(c)).toBe('advisory');
			const deleted = d.query('SELECT app_delete_my_account() AS gone');
			deleted.catch(() => {});
			// The deletion waits for the charge (364: the charge locked the person's row first) or, before 364, for
			// the counter lock or a row the charge holds.
			expect(await waitingOn(d)).not.toBeNull();
			await hold.query('COMMIT');
			await charged;
			await c.query('COMMIT');
			expect((await deleted).rows[0].gone).toBe(true);
			await d.query('COMMIT');
		} finally {
			await end(hold, c, d);
		}
		expect(await asOwner('SELECT 1 FROM app_user WHERE id = $1', [editor.id])).toEqual([]);
		const [usage] = await asOwner(`SELECT sum(cost_usd_micros)::float8 AS usd FROM assistant_usage WHERE project_id = $1`, [projectId]);
		expect(usage!.usd).toBe(5000);
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
	});

	it('the account’s owner is deleted while a member charges on its project: both commit', async () => {
		const [owner, coOwner] = (await Promise.all(['Aowner', 'Acoowner'].map((n) => signUp(n)))) as [User, User];
		const projectId = (await owner.call('POST', '/projects', { name: 'Lock order, owner deletion' })).body.project.id;
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: coOwner.email, role: 'owner' })).status).toBeLessThan(300);
		const acct = await account(projectId);
		expect(acct).toBeTruthy();
		// Nothing spent on the account this month yet: the charge's trigger inserts the account's month counter
		// row (and its pool membership), whose foreign key check needs a share lock on the billing account row.
		const reservation = await begin(coOwner, projectId);
		expect(await asOwner('SELECT 1 FROM assistant_month_counter WHERE billing_account_id = $1', [acct])).toEqual([]);

		const hold = await open();
		const c = await open(coOwner);
		const d = await open(owner);
		try {
			await hold.query('SELECT assistant_counter_lock()');
			const charged = chargeOn(c, projectId, reservation, 3000);
			charged.catch(() => {});
			expect(await waitingOn(c)).toBe('advisory');
			const deleted = d.query('SELECT app_delete_my_account() AS gone');
			deleted.catch(() => {});
			// Before 364 the deletion locked the billing account row and then waited for the counter lock (its
			// BEFORE DELETE trigger), while the charge, next in line for the counter lock, would need that row.
			expect(await waitingOn(d)).not.toBeNull();
			await hold.query('COMMIT');
			await charged;
			await c.query('COMMIT');
			expect((await deleted).rows[0].gone).toBe(true);
			await d.query('COMMIT');
		} finally {
			await end(hold, c, d);
		}
		expect(await asOwner('SELECT 1 FROM billing_account WHERE id = $1', [acct])).toEqual([]);
		const [usage] = await asOwner(`SELECT sum(cost_usd_micros)::float8 AS usd FROM assistant_usage WHERE project_id = $1`, [projectId]);
		expect(usage!.usd).toBe(3000);
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
	});

	it('a person deletes their account while a begin settles their expired reservation: both commit', async () => {
		const [person, coOwner, other] = (await Promise.all(['Sperson', 'Scoowner', 'Sother'].map((n) => signUp(n)))) as [User, User, User];
		const projectId = (await person.call('POST', '/projects', { name: 'Lock order, settle' })).body.project.id;
		expect((await person.call('POST', `/projects/${projectId}/members`, { email: coOwner.email, role: 'owner' })).status).toBeLessThan(300);
		const otherProject = (await other.call('POST', '/projects', { name: 'Lock order, settle, other' })).body.project.id;
		expect(await account(projectId)).toBeTruthy();
		// The person's priced reservation, expired: the other person's begin settles it, so it locks the person's
		// row, the project and the person's billing account.
		await asOwner(
			`INSERT INTO assistant_reservation (project_id, user_id, month, day, reserved, reserved_usd_micros, created_at, expires_at)
			 VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, assistant_day_of(now()), 1000, 7000, now() - interval '10 minutes', now() - interval '1 minute')`,
			[projectId, person.id]
		);
		// The person's audit events, which the deletion's first trigger (app_user_pseudonymise) rewrites: holding them
		// pauses the deletion with the person's row locked and before 364's trigger locks the billing account.
		expect((await asOwner('SELECT 1 FROM audit_event WHERE actor_user_id = $1', [person.id])).length).toBeGreaterThan(0);

		const hold = await open();
		const d = await open(person);
		const b = await open(other);
		try {
			await hold.query('SELECT 1 FROM audit_event WHERE actor_user_id = $1 FOR UPDATE', [person.id]);
			const deleted = d.query('SELECT app_delete_my_account() AS gone');
			deleted.catch(() => {});
			expect(await waitingOn(d)).toMatch(/^(transactionid|tuple)$/);
			// The settle waits for the person's row. Before the fix it already held the project and the billing
			// account FOR KEY SHARE, which the deletion's trigger then asks FOR UPDATE.
			const began = b.query(
				`SELECT outcome FROM app_assistant_begin($1, 1000000000, 1000, 1000000000, 10000000000000, 150000, 1000, 300, $2, 300000, 20, 1000000000000000)`,
				[otherProject, PRICE]
			);
			began.catch(() => {});
			expect(await waitingOn(b)).toMatch(/^(transactionid|tuple)$/);
			await hold.query('COMMIT');
			expect((await deleted).rows[0].gone).toBe(true);
			await d.query('COMMIT');
			expect((await began).rows[0].outcome).toBe('ok');
			await b.query('COMMIT');
		} finally {
			await end(hold, d, b);
		}
		expect(await asOwner('SELECT 1 FROM app_user WHERE id = $1', [person.id])).toEqual([]);
		// The reservation was settled after the deletion: charged in full to the project, with no person.
		const [usage] = await asOwner(
			`SELECT sum(cost_usd_micros)::float8 AS usd FROM assistant_usage WHERE project_id = $1 AND user_id IS NULL`,
			[projectId]
		);
		expect(usage!.usd).toBe(7000);
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = ANY($1)', [[projectId, otherProject]]);
	});
});
