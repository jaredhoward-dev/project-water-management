// An evidence pack's lifecycle and short code, as the database and the routes
// hold them (112_evidence_pack, latest guard 188; docs/evidence-pack.md
// § Lifecycle and § The short code):
//
//   draft ──issue──▶ issued ──(a new version)──▶ superseded
//     └──withdraw──▶ withdrawn ◀──withdraw─────────┘
//
// Every move off that diagram is refused by evidence_pack_guard, for the
// schema owner too, and each allowed move is the positive control. The routes
// refuse issuing or signing anything but a draft, and withdraw a superseded
// pack. The short code (the hash's first 12 hex digits) is unique in the
// database, so two packs can never answer one verify link.
//
// The packs are planted past their guards (replica role) in the state each
// case needs; each move is tried in a transaction that is rolled back, so one
// pack per state serves every case. packs.db.test.ts drives the same
// lifecycle end to end from a real report.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Status = 'draft' | 'issued' | 'superseded' | 'withdrawn';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SIGN = `INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope,
	statement_version, statement_sha256, disclaimer_version, kind)
	VALUES ($1, $2, $3, 'Dr Planted', 'sacnasp', 'pr_sci_nat', 'water_resources', '400123/10', 'x', 'pack-signoff-1', repeat('a', 64), 'v3', 'specialist')`;

let owner: User;
const clients: pg.Client[] = [];
/** One project per state: an issued pack and a superseded one's issued successor each hold the project's one issued slot. */
const packs = {} as Record<Status, { projectId: string; id: string }>;

async function connect(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await c.connect();
	clients.push(c);
	return c;
}

/** Run `fn` past every trigger (replica role), committed. */
async function planted<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
	const c = await connect();
	await c.query('BEGIN');
	await c.query('SET LOCAL session_replication_role = replica');
	const out = await fn(c);
	await c.query('COMMIT');
	return out;
}

const insertPack = (c: pg.Client, p: { id: string; projectId: string; run: string; version?: number; supersedes?: string | null; status: Status; hash?: string; reason?: string | null }) =>
	c.query(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, supersedes_pack_id, status, manifest, manifest_sha256, report_version, engine_version, created_by,
			issued_at, issued_by, status_reason)
		 VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, 'evidence-8', '1.50.0', $8,
			CASE WHEN $6 IN ('issued', 'superseded') THEN now() END, CASE WHEN $6 IN ('issued', 'superseded') THEN $8::uuid END, $9)`,
		[p.id, p.projectId, p.run, p.version ?? 1, p.supersedes ?? null, p.status, p.hash ?? sha(p.id), owner.id, p.reason ?? null]
	);

async function newProject(name: string): Promise<{ projectId: string; run: string }> {
	const projectId = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const run = await planted(
		async (c) =>
			(
				await c.query<{ id: string }>(
					`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}') RETURNING id::text`,
					[projectId, owner.id]
				)
			).rows[0]!.id
	);
	return { projectId, run };
}

/**
 * Try moving a pack to `to` as the schema owner, signed in as its owner, through evidence_pack_guard; always
 * rolled back. 'ok' when the guard let it through, else the database's message.
 */
async function tryMove(packId: string, to: Status, extra = ''): Promise<string> {
	const c = await connect();
	await c.query('BEGIN');
	try {
		await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.id]);
		await c.query(`UPDATE evidence_pack SET status = $2${extra} WHERE id = $1`, [packId, to]);
		const { rows } = await c.query<{ status: string }>('SELECT status FROM evidence_pack WHERE id = $1', [packId]);
		return rows[0]!.status === to ? 'ok' : `still ${rows[0]!.status}`;
	} catch (e) {
		return (e as Error).message;
	} finally {
		await c.query('ROLLBACK');
	}
}

const statusOf = async (packId: string) => (await (await connect()).query<{ status: string }>('SELECT status FROM evidence_pack WHERE id = $1', [packId])).rows[0]!.status;
const packPath = (s: Status, tail = '') => `/projects/${packs[s].projectId}/packs/${packs[s].id}${tail}`;

beforeAll(async () => {
	owner = await signUp('Lifecycleowner');
	for (const status of ['draft', 'issued', 'withdrawn'] as const) {
		const { projectId, run } = await newProject(`Lifecycle ${status}`);
		const id = randomUUID();
		await planted(async (c) => {
			await insertPack(c, { id, projectId, run, status, reason: status === 'withdrawn' ? 'drafted in error' : null });
			// Issuing needs a sign-off (the guard): the draft has one, so draft → issued is refused for no other reason.
			if (status === 'draft') await c.query(SIGN, [projectId, id, owner.id]);
		});
		packs[status] = { projectId, id };
	}
	// A superseded version 1 and its issued version 2.
	const { projectId, run } = await newProject('Lifecycle superseded');
	const v1 = randomUUID();
	const v2 = randomUUID();
	await planted(async (c) => {
		await insertPack(c, { id: v1, projectId, run, status: 'issued' });
		await insertPack(c, { id: v2, projectId, run, version: 2, supersedes: v1, status: 'issued' });
		await c.query(`UPDATE evidence_pack SET status = 'superseded', superseded_by_pack_id = $2 WHERE id = $1`, [v1, v2]);
	});
	packs.superseded = { projectId, id: v1 };
});

afterAll(async () => {
	await Promise.all(clients.map((c) => c.end()));
});

describe('the status moves only along the lifecycle (evidence_pack_guard, as the schema owner)', () => {
	const withdraw = `, status_reason = 'no longer needed'`;

	it('allows draft → issued (signed), draft → withdrawn, issued → withdrawn and superseded → withdrawn (positive controls)', async () => {
		expect(await tryMove(packs.draft.id, 'issued')).toBe('ok');
		expect(await tryMove(packs.draft.id, 'withdrawn', withdraw)).toBe('ok');
		expect(await tryMove(packs.issued.id, 'withdrawn', withdraw)).toBe('ok');
		expect(await tryMove(packs.superseded.id, 'withdrawn', withdraw)).toBe('ok');
	});

	it.each([
		['draft', 'superseded'],
		['issued', 'draft'],
		['superseded', 'draft'],
		['superseded', 'issued'],
		['withdrawn', 'draft'],
		['withdrawn', 'issued'],
		['withdrawn', 'superseded']
	] as const)('refuses %s → %s', async (from, to) => {
		expect(await tryMove(packs[from].id, to)).toBe(`evidence pack ${packs[from].id} can't move from ${from} to ${to}`);
		expect(await statusOf(packs[from].id)).toBe(from);
	});

	it('refuses issuing a draft with no sign-off, and with no signed-in user', async () => {
		const { projectId, run } = await newProject('Lifecycle unsigned');
		const id = randomUUID();
		await planted((c) => insertPack(c, { id, projectId, run, status: 'draft' }));
		expect(await tryMove(id, 'issued')).toBe(`evidence pack ${id} has no sign-off, so it can't be issued`);
		const c = await connect();
		await c.query('BEGIN');
		await expect(c.query(`UPDATE evidence_pack SET status = 'issued' WHERE id = $1`, [packs.draft.id])).rejects.toThrow('an evidence pack is issued by a signed-in user');
		await c.query('ROLLBACK');
	});

	it('stamps the issue itself: a caller’s issued_at is overwritten with the transaction’s time', async () => {
		const c = await connect();
		await c.query('BEGIN');
		try {
			await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.id]);
			await c.query(`UPDATE evidence_pack SET status = 'issued', issued_at = '2001-01-01' WHERE id = $1`, [packs.draft.id]);
			const { rows } = await c.query<{ same: boolean; by: string }>('SELECT issued_at = now() AS same, issued_by::text AS by FROM evidence_pack WHERE id = $1', [packs.draft.id]);
			expect(rows[0]).toEqual({ same: true, by: owner.id });
		} finally {
			await c.query('ROLLBACK');
		}
	});
});

describe('the routes refuse what the lifecycle doesn’t allow', () => {
	const signBody = {
		fullName: 'Dr A. Hydrologist',
		registrationBody: 'sacnasp',
		registrationCategory: 'pr_sci_nat',
		registrationField: 'water_resources',
		registrationNo: '400999/20',
		scope: 'the hydrology of the evidence pack',
		confirmed: [],
		statementSha256: 'a'.repeat(64)
	};

	it('issues only a draft: an issued, a superseded or a withdrawn pack is 409, left as it was', async () => {
		for (const s of ['issued', 'superseded', 'withdrawn'] as const) {
			const res = await owner.call('POST', packPath(s, '/issue'));
			expect(res.status, s).toBe(409);
			expect(res.body.error).toBe(`only a draft pack is issued; this one is ${s}`);
			expect(await statusOf(packs[s].id)).toBe(s);
		}
	});

	it('signs only a draft: a sign-off of a withdrawn or superseded pack is 409, and none is stored', async () => {
		for (const s of ['superseded', 'withdrawn'] as const) {
			const res = await owner.call('POST', packPath(s, '/signoffs'), signBody);
			expect(res.status, s).toBe(409);
			expect(res.body.error).toBe(`only a draft pack is signed; this one is ${s}`);
			const { rows } = await (await connect()).query<{ n: number }>('SELECT count(*)::int AS n FROM signoff WHERE pack_id = $1', [packs[s].id]);
			expect(rows[0]!.n).toBe(0);
		}
	});

	it('deletes no pack past draft, naming its status', async () => {
		for (const s of ['issued', 'superseded', 'withdrawn'] as const) {
			const res = await owner.call('DELETE', packPath(s));
			expect(res.status, s).toBe(409);
			expect(res.body.error).toBe(
				s === 'withdrawn' ? 'a withdrawn pack is never deleted' : `${s === 'issued' ? 'an' : 'a'} ${s} pack is never deleted; withdraw it instead`
			);
		}
		// A signed draft is kept too, for its sign-off.
		expect((await owner.call('DELETE', packPath('draft'))).status).toBe(409);
	});

	it('takes a withdrawal reason of 1 to 1 000 characters, trimmed; a blank or longer one is 400 and changes nothing', async () => {
		for (const reason of ['', '   ', 'x'.repeat(1001), 'a\u0000b']) expect((await owner.call('POST', packPath('superseded', '/withdraw'), { reason })).status, JSON.stringify(reason)).toBe(400);
		expect(await statusOf(packs.superseded.id)).toBe('superseded');
	});

	it('withdraws a superseded pack with its reason (positive control), and only once', async () => {
		const reason = 'r'.repeat(1000);
		const res = await owner.call('POST', packPath('superseded', '/withdraw'), { reason: `  ${reason}  ` });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.pack).toMatchObject({ status: 'withdrawn', statusReason: reason });
		expect((await owner.call('POST', packPath('superseded', '/withdraw'), { reason: 'again' })).status).toBe(409);
	});
});

describe('the short code (the manifest hash’s first 12 hex digits) names one pack', () => {
	it('refuses a second pack whose hash shares the first 12 digits, and takes one that differs in the 12th (positive control)', async () => {
		const { projectId, run } = await newProject('Short codes');
		const prefix = sha(randomUUID()).slice(0, 12);
		const tail = (c: string) => c.repeat(52);
		await planted((c) => insertPack(c, { id: randomUUID(), projectId, run, status: 'draft', hash: prefix + tail('0') }));
		const collide = planted((c) => insertPack(c, { id: randomUUID(), projectId, run, status: 'draft', hash: prefix + tail('1') }));
		await expect(collide).rejects.toMatchObject({ code: '23505', constraint: 'evidence_pack_short_code_idx' });
		const next = (prefix.slice(0, 11) + ((parseInt(prefix[11]!, 16) + 1) % 16).toString(16)) as string;
		await expect(planted((c) => insertPack(c, { id: randomUUID(), projectId, run, status: 'draft', hash: next + tail('0') }))).resolves.toBeDefined();
	});
});
