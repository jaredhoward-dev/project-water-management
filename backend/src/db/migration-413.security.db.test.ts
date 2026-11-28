// 413_rls_sweep_closes: the three loose ends of the 2026-11-27 RLS sweep
// (docs/security.md § Authorization). Each refusal has its positive control.
//
//  1. A queued delineation request keeps its project and maker: an editor of
//     two projects can't move it, or name someone else as who queued it;
//     the worker's moves and an account deletion's foreign key still work.
//  2. app_share_allowed answers only a caller with a role in the project
//     (an outsider and no user get false, a member the rule); the share
//     triggers still answer by the rule whoever runs them (the operator,
//     with no user, changing a party's case keeps the share).
//  3. report_delete needs the requester to still be a viewer: a requester
//     removed from the project deletes none of their reports, even with no WHERE.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { buildLadder, clearLadderJobs, type LadderCtx, type User } from '../__tests__/routeSamples.js';
import { type Db, withoutUser, withUser } from './tx.js';

let c: LadderCtx;
let elsewhereId: string;
let consultant: User;
let outsider: User;
let sid: string;

const CHECK = { code: '23514' };
const at = () => `/projects/${c.projectId}`;

beforeAll(async () => {
	c = await buildLadder('M');
	// Another project the editor also edits (they own it).
	elsewhereId = (await c.editor.call('POST', '/projects', { name: '413 elsewhere' })).body.project.id;
	[consultant, outsider] = (await Promise.all(['Mconsultant', 'Moutsider'].map((n) => signUp(n)))) as [User, User];
	expect((await c.owner.call('POST', `${at()}/members`, { email: consultant.email, role: 'contributor' })).status).toBe(201);
	for (const u of [c.contributor, consultant]) expect((await c.owner.call('PATCH', `${at()}/members/${u.id}`, { party: 'Rooikloof Trust' })).status).toBe(200);
	const app = await c.contributor.call('POST', `${at()}/scenarios`, { name: 'An application', baseRunId: c.runId, ops: [] });
	expect(app.status, JSON.stringify(app.body)).toBe(201);
	sid = app.body.scenario.id;
	expect((await c.contributor.call('POST', `${at()}/scenarios/${sid}/members`, { userId: consultant.id })).status).toBe(201);
}, 180_000);

afterAll(async () => {
	await clearLadderJobs(c);
});

describe('a queued delineation request keeps its project and its maker', () => {
	const queued = async () =>
		(
			await asOwner(
				`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, from_window, created_by) VALUES ($1, 'outlet', 21.31, -33.69, 256, $2) RETURNING id`,
				[c.projectId, c.editor.id]
			)
		)[0]!.id as string;

	it("can't be moved to another project its editor edits, job cleared or not", async () => {
		const rid = await queued();
		for (const sql of ['UPDATE delineation_request SET project_id = $2 WHERE id = $1', 'UPDATE delineation_request SET project_id = $2, job_id = NULL WHERE id = $1'])
			await expect(withUser(c.editor.id, (db) => db.query(sql, [rid, elsewhereId]))).rejects.toMatchObject(CHECK);
		expect((await asOwner('SELECT project_id FROM delineation_request WHERE id = $1', [rid]))[0]).toEqual({ project_id: c.projectId });
	});

	it("can't name someone else as who queued it, nor change when, while queued", async () => {
		const rid = await queued();
		await expect(withUser(c.editor.id, (db) => db.query('UPDATE delineation_request SET created_by = $2 WHERE id = $1', [rid, c.owner.id]))).rejects.toMatchObject(CHECK);
		await expect(withUser(c.editor.id, (db) => db.query('UPDATE delineation_request SET created_by = NULL WHERE id = $1', [rid]))).rejects.toMatchObject(CHECK);
		await expect(withUser(c.editor.id, (db) => db.query(`UPDATE delineation_request SET created_at = now() - interval '1 day' WHERE id = $1`, [rid]))).rejects.toMatchObject(CHECK);
		expect((await asOwner('SELECT created_by FROM delineation_request WHERE id = $1', [rid]))[0]).toEqual({ created_by: c.editor.id });
	});

	it("positive controls: a queued request's outcome is still written, and the maker's foreign key still clears", async () => {
		const rid = await queued();
		const r = await withUser(c.editor.id, (db) =>
			db.query(`UPDATE delineation_request SET status = 'refused', refusal_code = 'off', refusal = 'x', finished_at = now() WHERE id = $1`, [rid])
		);
		expect(r.rowCount).toBe(1);
		// An account that goes: its requests stay, nameless.
		const gone = await signUp('Mgone');
		const [{ id: mine }] = (await asOwner(
			`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, from_window, created_by) VALUES ($1, 'outlet', 21.3, -33.6, 256, $2) RETURNING id`,
			[c.projectId, gone.id]
		)) as [{ id: string }];
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		expect((await asOwner('SELECT created_by FROM delineation_request WHERE id = $1', [mine]))[0]).toEqual({ created_by: null });
	});
});

describe('app_share_allowed answers only a member of the project', () => {
	const ask = async (db: Db) => (await db.query<{ ok: boolean }>('SELECT app_share_allowed($1, $2, $3) AS ok', [c.projectId, c.contributor.id, consultant.id])).rows[0]!.ok;

	it('is false for a signed-in person with no role here, and with no user (positive control: a member gets the rule)', async () => {
		expect(await withUser(outsider.id, ask)).toBe(false);
		expect(await withoutUser(ask)).toBe(false);
		expect(await withUser(c.viewer.id, ask)).toBe(true);
		expect(await withUser(c.contributor.id, ask)).toBe(true);
	});

	it('is not the rule water_app can reach: share_allowed_rule is the schema owner’s', async () => {
		await expect(withUser(c.owner.id, (db) => db.query('SELECT share_allowed_rule($1, $2, $3)', [c.projectId, c.contributor.id, consultant.id]))).rejects.toMatchObject({
			code: '42501'
		});
	});

	it('the share triggers still follow the rule with no user: the operator changing a party’s case keeps the share', async () => {
		await asOwner(`UPDATE project_member SET party = upper(party) WHERE project_id = $1 AND user_id = $2`, [c.projectId, consultant.id]);
		expect((await asOwner('SELECT count(*)::int AS n FROM scenario_member WHERE scenario_id = $1 AND user_id = $2', [sid, consultant.id]))[0].n).toBe(1);
		// And a party the rule refuses is pruned (positive control for the trigger).
		await asOwner(`UPDATE project_member SET party = 'Another party' WHERE project_id = $1 AND user_id = $2`, [c.projectId, consultant.id]);
		expect((await asOwner('SELECT count(*)::int AS n FROM scenario_member WHERE scenario_id = $1 AND user_id = $2', [sid, consultant.id]))[0].n).toBe(0);
		// The candidate list (app_share_candidates) now leaves them out, and names nobody to an outsider.
		const names = async (u: User) => withUser(u.id, async (db) => (await db.query('SELECT candidate_id FROM app_share_candidates($1)', [c.projectId])).rows.map((r) => r.candidate_id));
		expect(await names(c.contributor)).not.toContain(consultant.id);
		expect(await names(outsider)).toEqual([]);
	});
});

describe('report_delete needs the requester to still be a viewer', () => {
	it('a requester removed from the project deletes none of their reports, even with no WHERE (positive control: while a viewer)', async () => {
		const requester = await signUp('Mrequester');
		expect((await c.owner.call('POST', `${at()}/members`, { email: requester.email, role: 'viewer' })).status).toBe(201);
		const insert = () =>
			withUser(requester.id, async (db) => (await db.query<{ id: string }>('INSERT INTO report (project_id, requested_by) VALUES ($1, app_current_user_id()) RETURNING id', [c.projectId])).rows[0]!.id);
		const kept = await insert();
		const deleted = await insert();
		// Positive control: a viewer deletes their own.
		expect((await withUser(requester.id, (db) => db.query('DELETE FROM report WHERE id = $1', [deleted]))).rowCount).toBe(1);
		// Removed from the project.
		expect((await c.owner.call('DELETE', `${at()}/members/${requester.id}`)).status).toBe(204);
		const r = await withUser(requester.id, (db) => db.query('DELETE FROM report'));
		expect(r.rowCount).toBe(0);
		expect((await asOwner('SELECT count(*)::int AS n FROM report WHERE id = $1', [kept]))[0].n).toBe(1);
	});
});
