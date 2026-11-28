// What a member below editor can change through RLS alone, swept over every
// project table (docs/security.md § Authorization; CLAUDE.md rules 1 and 5).
//
// The role ladder (role-ladder.db.test.ts) proves each route asks for the
// right role; this proves the second layer, the policies, hold if a route
// forgets: a viewer, a farmer, an editor demoted to viewer, and a viewer
// removed from the project each try UPDATE and DELETE on every row of the
// project in every table with a project_id, inside a savepoint that is rolled
// back. What each may change is listed by table (an owner-side WHERE, as
// scenarios/applicant.security.db.test.ts does for an applicant): their own
// notes, their own alert preferences, and leaving the project. Anything else
// they reach fails the sweep. The removed viewer must also read nothing.
//
// The UPDATE sets a column the app role may update (__tests__/rlsProbe.ts),
// so it reaches the policy on the tables whose grants leave out project_id
// (note, model_run, project_member, evidence_pack, share_link, api_key, …).
//
// The project is the role ladder's (every kind of row a route names) plus an
// evidence pack, a delineation request, an allocation import and rows the
// below-editor members wrote themselves. Positive controls: the owner's and
// the editor's own sweeps reach those tables, and each member reaches the
// rows the list gives them.
import { buildPackManifest, ENGINE_VERSION, packManifestText } from '@water-management/engine';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { buildLadder, clearLadderJobs, type LadderCtx, type User } from '../__tests__/routeSamples.js';
import { updatableColumns, updateProbe } from '../__tests__/rlsProbe.js';
import { withUser } from '../db/tx.js';

/** What a member below editor may UPDATE or DELETE, by table (owner side; $1 the project, $2 the member). */
const BELOW_EDITOR_CHANGE: Record<string, { update?: string; delete?: string }> = {
	// Their own notes: editing the text, or hiding it (note_update, 037; a note is never deleted, only marked).
	note: { update: `author_id = $2` },
	// Their own alert preferences (alert_subscription_own, 051).
	alert_subscription: { update: `user_id = $2`, delete: `user_id = $2` },
	// Leaving the project (member_delete: anyone may remove themselves).
	project_member: { delete: `user_id = $2` }
};

type Row = { k: string };
let c: LadderCtx;
let leaver: User;
let tables: { t: string; key: string }[] = [];
let columns: Map<string, string[]>;

/** The primary-key columns of `t` as a text key (run_series has none: its natural key). */
async function keyExpr(t: string) {
	const cols = (
		await asOwner(
			`SELECT a.attname AS c FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			 WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attnum`,
			[t]
		)
	).map((r: { c: string }) => r.c as string);
	const key = cols.length ? cols : ['run_id', 'node_id', 'key'];
	return `jsonb_build_array(${key.map((col) => `x."${col}"`).join(', ')})::text`;
}

async function ownerKeys(t: string, key: string, where: string, userId: string) {
	const sql = `SELECT ${key} AS k FROM "${t}" x WHERE x.project_id = $1 AND $2::uuid IS NOT NULL AND (${where})`;
	return new Set((await asOwner(sql, [c.projectId, userId])).map((r: Row) => r.k));
}

/** Every UPDATE and DELETE of the project's rows as `userId`, each rolled back: the keys each reached, by `verb table`. */
async function sweep(userId: string): Promise<Map<string, string[]>> {
	const reached = new Map<string, string[]>();
	await withUser(userId, async (db) => {
		for (const { t, key } of tables) {
			const stmts = {
				update: updateProbe(columns, t, 'project_id', `${key} AS k`),
				delete: `DELETE FROM "${t}" x WHERE x.project_id = $1 RETURNING ${key} AS k`
			};
			for (const [verb, sql] of Object.entries(stmts)) {
				if (!sql) continue;
				await db.query('SAVEPOINT attempt');
				try {
					const { rows } = await db.query<Row>(sql, [c.projectId]);
					if (rows.length) reached.set(`${verb} ${t}`, rows.map((r) => r.k));
				} catch (e) {
					// No grant (42501) is as good as zero rows. Anything else (a trigger, a foreign
					// key) means the statement reached a row RLS let through.
					const code = (e as { code?: string }).code;
					if (code !== '42501') reached.set(`${verb} ${t}`, [`reached a row (${code})`]);
				} finally {
					await db.query('ROLLBACK TO SAVEPOINT attempt');
				}
			}
		}
	});
	return reached;
}

/** The rows `userId` reached that BELOW_EDITOR_CHANGE doesn't give them. */
async function beyondTheirOwn(userId: string, reached: Map<string, string[]>) {
	const wrong: string[] = [];
	for (const [what, keys] of reached) {
		const [verb, t] = what.split(' ') as ['update' | 'delete', string];
		const key = tables.find((x) => x.t === t)!.key;
		const allowed = await ownerKeys(t, key, BELOW_EDITOR_CHANGE[t]?.[verb] ?? 'false', userId);
		const extra = keys.filter((k) => !allowed.has(k));
		if (extra.length) wrong.push(`${what}: ${extra.length} row(s) not theirs, e.g. ${extra[0]}`);
	}
	return wrong;
}

beforeAll(async () => {
	c = await buildLadder('B');
	const at = `/projects/${c.projectId}`;
	const ok = async (u: User, method: string, path: string, body?: unknown) => {
		const r = await u.call(method, `${at}${path}`, body);
		expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
		return r.body;
	};
	// An allocation import (allocation_source and its rows).
	await ok(c.owner, 'POST', '/allocations/import/commit', {
		kind: 'csv',
		fileName: 'b.csv',
		text: 'registration_no,farm,authorisation,water_source,volume_m3_year\nB-1,Farm B,licence,surface,500\n'
	});
	// An evidence pack of the run, planted as a draft (drafting through the route needs a nominated run and its ensemble).
	const ev = (await ok(c.owner, 'GET', `/runs/${c.runId}/evidence-report`)).report;
	const packId = crypto.randomUUID();
	const manifest = buildPackManifest({ pack: { id: packId, version: 1, supersedes: null }, project: ev.identity.project, report: ev, engine: { version: ENGINE_VERSION, build: null } });
	await asOwner(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
		 VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
		[packId, c.projectId, c.runId, JSON.stringify(manifest), createHash('sha256').update(packManifestText(manifest), 'utf8').digest('hex'), ev.version, ENGINE_VERSION, c.editor.id]
	);
	// A delineation request still queued (191_delineation_request).
	await asOwner(`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, from_window, created_by) VALUES ($1, 'outlet', 21.31, -33.69, 256, $2)`, [
		c.projectId,
		c.editor.id
	]);
	// Rows the members wrote themselves: notes, the viewer's alert preferences, and the editor's team note and scenario
	// (before the editor is demoted below).
	await ok(c.viewer, 'POST', '/notes', { body: 'Viewer note' });
	await ok(c.farmer, 'POST', '/notes', { body: 'Farmer note', nodeId: c.farmId });
	await ok(c.editor, 'POST', '/notes', { body: 'Editor note' });
	await ok(c.editor, 'POST', '/scenarios', { name: 'Editor scenario', baseRunId: c.runId, ops: [] });
	expect((await c.viewer.call('PUT', `/me/alerts/${c.projectId}`, { items: [{ kind: 'all', mode: 'immediate' }] })).status).toBe(200);
	// A viewer who writes a note and alert preferences, and is removed later.
	leaver = await signUp('Bleaver');
	await ok(c.owner, 'POST', '/members', { email: leaver.email, role: 'viewer' });
	await ok(leaver, 'POST', '/notes', { body: 'Leaver note' });
	expect((await leaver.call('PUT', `/me/alerts/${c.projectId}`, { items: [{ kind: 'all', mode: 'immediate' }] })).status).toBe(200);

	columns = await updatableColumns();
	const scoped = await asOwner(
		`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
		   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped)
		   AND has_table_privilege('water_app', c.oid, 'SELECT')
		 ORDER BY 1`
	);
	tables = await Promise.all(scoped.map(async ({ t }: { t: string }) => ({ t, key: await keyExpr(t) })));
}, 180_000);

afterAll(async () => {
	await clearLadderJobs(c);
});

describe('the inventory', () => {
	it('sweeps every project table, the lane tables among them holding rows here (not vacuous)', async () => {
		expect(tables.length).toBeGreaterThan(40);
		for (const t of Object.keys(BELOW_EDITOR_CHANGE)) expect(tables.map((x) => x.t), t).toContain(t);
		const filled: string[] = [];
		for (const { t } of tables) if ((await asOwner(`SELECT 1 FROM "${t}" WHERE project_id = $1 LIMIT 1`, [c.projectId])).length) filled.push(t);
		expect(filled).toEqual(
			expect.arrayContaining([
				'note',
				'scenario',
				'allocation',
				'allocation_source',
				'evidence_pack',
				'delineation_request',
				'delineation_proposal',
				'api_key',
				'share_link',
				'alert_subscription',
				'model_run',
				'run_publication'
			])
		);
	});

	it('positive control: the owner and the editor reach the rows below-editor members are refused', async () => {
		const owner = [...(await sweep(c.owner.id)).keys()];
		expect(owner).toEqual(
			expect.arrayContaining(['update api_key', 'update share_link', 'update project_member', 'update evidence_pack', 'update model_run', 'update run_publication'])
		);
		const editor = [...(await sweep(c.editor.id)).keys()];
		expect(editor).toEqual(
			expect.arrayContaining([
				'update scenario',
				'delete scenario',
				'update allocation',
				'delete allocation',
				'delete allocation_source',
				'update evidence_pack',
				'delete evidence_pack',
				'update delineation_request',
				'delete delineation_request',
				'update model_run',
				'update note'
			])
		);
	});
});

describe('below editor, RLS lets each change only their own rows', () => {
	it('a viewer: their own note and alert preferences, and leaving (positive control: they reach those)', async () => {
		const reached = await sweep(c.viewer.id);
		expect(await beyondTheirOwn(c.viewer.id, reached)).toEqual([]);
		expect([...reached.keys()]).toEqual(expect.arrayContaining(['update note', 'update alert_subscription', 'delete alert_subscription', 'delete project_member']));
	});

	it('a farmer: their own note, and leaving (positive control: they reach those)', async () => {
		const reached = await sweep(c.farmer.id);
		expect(await beyondTheirOwn(c.farmer.id, reached)).toEqual([]);
		expect([...reached.keys()]).toEqual(expect.arrayContaining(['update note', 'delete project_member']));
	});

	it('an editor demoted to viewer: at once only what a viewer may, not the scenario, pack or request they could change', async () => {
		const before = await sweep(c.editor.id);
		expect([...before.keys()]).toEqual(expect.arrayContaining(['update scenario', 'update evidence_pack', 'update delineation_request']));
		expect((await c.owner.call('PATCH', `/projects/${c.projectId}/members/${c.editor.id}`, { role: 'viewer' })).status).toBe(200);
		const reached = await sweep(c.editor.id);
		expect(await beyondTheirOwn(c.editor.id, reached)).toEqual([]);
		// Still their own note (positive control).
		expect([...reached.keys()]).toEqual(expect.arrayContaining(['update note', 'delete project_member']));
	});

	it('a viewer removed from the project: reads no row and changes none, their own note and preferences included', async () => {
		const reachedBefore = await sweep(leaver.id);
		expect([...reachedBefore.keys()]).toEqual(expect.arrayContaining(['update note', 'update alert_subscription']));
		expect((await c.owner.call('DELETE', `/projects/${c.projectId}/members/${leaver.id}`)).status).toBe(204);
		const seen: string[] = [];
		await withUser(leaver.id, async (db) => {
			for (const { t } of tables) {
				const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${t}" WHERE project_id = $1`, [c.projectId]);
				if (rows[0].n > 0) seen.push(`${t} (${rows[0].n})`);
			}
		});
		expect(seen).toEqual([]);
		expect([...(await sweep(leaver.id)).keys()]).toEqual([]);
		// Their note stays, the project's record, for the members (positive control).
		expect((await asOwner(`SELECT count(*)::int AS n FROM note WHERE project_id = $1 AND author_id = $2`, [c.projectId, leaver.id]))[0].n).toBe(1);
	});
});
