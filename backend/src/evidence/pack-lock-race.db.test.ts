// A pack route that waits for another transaction's lock on the pack reads
// the row that transaction left (docs/evidence-pack.md § Lifecycle). The
// routes that change a pack (withdraw, delete, issue, sign) lock its row
// FOR UPDATE and then decide from what they read. Read in the same statement
// as the lock, the pack was the one the statement's snapshot saw before the
// wait: a withdrawal that waited for an issue recorded `from: 'draft'` in the
// project's history although it withdrew an issued pack, a second withdrawal
// failed on the guard's raw 409 instead of "already withdrawn", and a delete
// that waited for a sign-off counted none and failed on the foreign key's 400.
//
// One connection as the schema owner holds the other transaction open; the
// route waits on it (pg_stat_activity shows it blocked on a lock), then reads
// what it committed. Positive controls: the same calls with nothing in flight.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SIGN = `INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope,
	statement_version, statement_sha256, disclaimer_version, kind)
	VALUES ($1, $2, $3, 'Dr Planted', 'sacnasp', 'pr_sci_nat', 'water_resources', '400123/10', 'x', 'pack-signoff-1', repeat('a', 64), 'v3', 'specialist')`;

let owner: User;
let projectId: string;
let run: string;
const clients: pg.Client[] = [];

async function connect(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await c.connect();
	clients.push(c);
	return c;
}

/** A draft planted past its guards; `signed` adds a specialist sign-off. */
async function plantDraft(signed: boolean): Promise<string> {
	const c = await connect();
	const id = randomUUID();
	await c.query('BEGIN');
	await c.query('SET LOCAL session_replication_role = replica');
	await c.query(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, status, manifest, manifest_sha256, report_version, engine_version, created_by)
		 VALUES ($1, $2, $3, 1, 'draft', '{}', $4, 'evidence-8', '1.50.0', $5)`,
		[id, projectId, run, sha(id), owner.id]
	);
	if (signed) await c.query(SIGN, [projectId, id, owner.id]);
	await c.query('COMMIT');
	return id;
}

/** Hold `sql` on the pack open in a transaction, run `call` (which must wait for it), then commit and return what `call` answered. */
async function whileHeld<T>(sql: string, params: unknown[], call: () => Promise<T>): Promise<T> {
	const holder = await connect();
	await holder.query('BEGIN');
	await holder.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.id]);
	await holder.query(sql, params);
	const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
	let settled = false;
	const pending = call().finally(() => (settled = true));
	// The route's transaction waits on the holder's lock.
	await expect
		.poll(
			async () =>
				(
					await holder.query<{ n: number }>(
						`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
						[holderPid]
					)
				).rows[0]!.n
		)
		.toBe(1);
	expect(settled).toBe(false);
	await holder.query('COMMIT');
	return pending;
}

const withdrawnFrom = async (packId: string) =>
	(
		await (await connect()).query<{ from: string }>(
			`SELECT subject->>'from' AS from FROM audit_event WHERE project_id = $1 AND kind = 'pack.withdrawn' AND subject->>'packId' = $2`,
			[projectId, packId]
		)
	).rows.map((r) => r.from);

beforeAll(async () => {
	owner = await signUp('Lockraceowner');
	projectId = (await owner.call('POST', '/projects', { name: 'Pack lock race' })).body.project.id;
	const c = await connect();
	await c.query('BEGIN');
	await c.query('SET LOCAL session_replication_role = replica');
	run = (
		await c.query<{ id: string }>(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}') RETURNING id::text`,
			[projectId, owner.id]
		)
	).rows[0]!.id;
	await c.query('COMMIT');
});

afterAll(async () => {
	await Promise.all(clients.map((c) => c.end()));
});

const path = (packId: string, tail = '') => `/projects/${projectId}/packs/${packId}${tail}`;

describe('a pack route that waits for another change to the pack reads what that change committed', () => {
	it('control: a draft withdrawn with nothing in flight is recorded as withdrawn from draft', async () => {
		const pack = await plantDraft(true);
		const res = await owner.call('POST', path(pack, '/withdraw'), { reason: 'drafted in error' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(await withdrawnFrom(pack)).toEqual(['draft']);
	});

	it('a withdrawal that waited for an issue records that it withdrew an issued pack', async () => {
		const pack = await plantDraft(true);
		const res = await whileHeld(`UPDATE evidence_pack SET status = 'issued' WHERE id = $1`, [pack], () =>
			owner.call('POST', path(pack, '/withdraw'), { reason: 'issued in error' })
		);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.pack).toMatchObject({ status: 'withdrawn', statusReason: 'issued in error' });
		expect(await withdrawnFrom(pack)).toEqual(['issued']);
	});

	it('a withdrawal that waited for another withdrawal says it is already withdrawn, and keeps the first reason', async () => {
		const pack = await plantDraft(true);
		const res = await whileHeld(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = 'first' WHERE id = $1`, [pack], () =>
			owner.call('POST', path(pack, '/withdraw'), { reason: 'second' })
		);
		expect(res.status).toBe(409);
		expect(res.body.error).toBe('this pack is already withdrawn');
		const { rows } = await (await connect()).query<{ r: string }>('SELECT status_reason AS r FROM evidence_pack WHERE id = $1', [pack]);
		expect(rows[0]!.r).toBe('first');
	});

	it('control: an unsigned draft is deleted', async () => {
		const pack = await plantDraft(false);
		expect((await owner.call('DELETE', path(pack))).status).toBe(204);
	});

	it('a delete that waited for a sign-off keeps the signed draft, and says why', async () => {
		const pack = await plantDraft(false);
		const res = await whileHeld(SIGN, [projectId, pack, owner.id], () => owner.call('DELETE', path(pack)));
		expect(res.status).toBe(409);
		expect(res.body.error).toBe('a signed draft is kept with its sign-off; withdraw it instead');
	});
});
