// The tick's alert housekeeping (jobs/runner.ts): the scheduled checks (app_alert_schedule, 341) are spaced
// ALERT_CHECK_GAP apart per catchment and run as an editor who still is one, and the alert purge
// (app_purge_alerts, 051) deletes finished deliveries and cleared events past ALERT_RETENTION_DAYS but never a
// delivery still waiting to go, nor a firing event. Each "not queued" / "kept" has a positive control.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { ALERT_CHECK_GAP, ALERT_RETENTION_DAYS } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let projectId: string;

const schedule = async (gap = ALERT_CHECK_GAP) =>
	(await withoutUser((db) => db.query<{ n: number }>(`SELECT app_alert_schedule($1, $2::interval, 1) AS n`, [projectId, gap]))).rows[0]!.n;
const checks = () => asOwner(`SELECT id, status, acting_user_id FROM job WHERE project_id = $1 AND kind = 'alert_eval' ORDER BY created_at`, [projectId]);
/** Mark the queued check as finished `ago`, as a tick that ran it would leave it. */
const finishCheck = (ago: string) =>
	asOwner(
		`UPDATE job SET status = 'done', finished_at = now() - $2::interval, created_at = now() - $2::interval
		 WHERE project_id = $1 AND kind = 'alert_eval' AND status = 'queued'`,
		[projectId, ago]
	);
/** One statement as the schema owner with triggers off: alert_event_guard stamps opened_at and cleared_at with now(). */
async function pastTheGuard(sql: string, params: unknown[]) {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		await client.query(sql, params);
		await client.query('COMMIT');
	} finally {
		await client.end();
	}
}
const clearChecks = () => asOwner(`DELETE FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [projectId]);

beforeAll(async () => {
	[owner, editor] = await Promise.all([signUp('Rtowner'), signUp('Rteditor')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Alert housekeeping' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	// Made by the editor through the rule editor (alert_rule.created_by is whoever made it).
	expect((await editor.call('PUT', `/projects/${projectId}/alert-rules`, { rules: [{ kind: 'job_dead', threshold: 1, enabled: true }] })).status).toBe(200);
});

afterAll(async () => {
	await clearChecks();
	await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [projectId]);
});

describe('scheduled alert checks (app_alert_schedule)', () => {
	it('queues one check as the editor who made the rule, and no second while it waits', async () => {
		await clearChecks();
		expect(await schedule()).toBe(1);
		expect(await schedule()).toBe(0);
		expect((await checks()).map((j) => [j.status, j.acting_user_id])).toEqual([['queued', editor.id]]);
	});

	it(`waits ${ALERT_CHECK_GAP} after the last check before queuing the next (positive control: past the gap, it does)`, async () => {
		await clearChecks();
		expect(await schedule()).toBe(1);
		await finishCheck('30 minutes');
		expect(await schedule()).toBe(0);
		await asOwner(`UPDATE job SET created_at = now() - interval '61 minutes' WHERE project_id = $1 AND kind = 'alert_eval'`, [projectId]);
		expect(await schedule()).toBe(1);
	});

	it('a check failing and waiting to retry holds the next back, whatever its age', async () => {
		await clearChecks();
		expect(await schedule()).toBe(1);
		await asOwner(
			`UPDATE job SET status = 'failed', attempts = 1, created_at = now() - interval '3 days' WHERE project_id = $1 AND kind = 'alert_eval'`,
			[projectId]
		);
		expect(await schedule('0')).toBe(0);
	});

	it('runs as an owner once the rule’s maker is no longer an editor (positive control: the first test ran as the maker)', async () => {
		await clearChecks();
		await asOwner(`UPDATE project_member SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [projectId, editor.id]);
		try {
			expect(await schedule()).toBe(1);
			expect((await checks()).map((j) => j.acting_user_id)).toEqual([owner.id]);
		} finally {
			await asOwner(`UPDATE project_member SET role = 'editor' WHERE project_id = $1 AND user_id = $2`, [projectId, editor.id]);
		}
	});

	it('only the worker schedules', async () => {
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_alert_schedule($1, interval '0', 1)`, [projectId]))).rejects.toMatchObject({ code: '42501' });
	});
});

describe(`the alert purge (app_purge_alerts, ${ALERT_RETENTION_DAYS} days)`, () => {
	it('deletes finished deliveries and cleared events past the age; keeps waiting deliveries, firing events and anything newer', async () => {
		const [rule] = await asOwner(`SELECT id FROM alert_rule WHERE project_id = $1 AND kind = 'job_dead'`, [projectId]);
		const old = `now() - interval '${ALERT_RETENTION_DAYS + 1} days'`;
		const event = async (state: 'firing' | 'cleared', aged: boolean) => {
			const [e] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, $3, 1, '{"count":1}') RETURNING id`, [
				rule.id,
				projectId,
				state
			]);
			if (aged)
				await pastTheGuard(`UPDATE alert_event SET opened_at = ${old}, cleared_at = CASE WHEN state = 'cleared' THEN ${old} END WHERE id = $1`, [e.id]);
			return e.id as string;
		};
		const oldCleared = await event('cleared', true);
		const newCleared = await event('cleared', false);
		const oldFiring = await event('firing', true);
		const delivery = (e: string, u: User, status: string) =>
			asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, created_at) VALUES ($1, $2, $3, 'immediate', $4, ${old})`, [e, u.id, projectId, status]);
		// On the firing event (kept), so a delivery's own fate is what's under test.
		await delivery(oldFiring, owner, 'sent');
		await delivery(oldFiring, editor, 'pending');
		await delivery(newCleared, owner, 'digest');
		await delivery(newCleared, editor, 'failed');

		const n = (await withoutUser((db) => db.query<{ n: number }>('SELECT app_purge_alerts(make_interval(days => $1)) AS n', [ALERT_RETENTION_DAYS]))).rows[0]!.n;
		// Other files' rows past the age may go too: at least this file's three.
		expect(n).toBeGreaterThanOrEqual(3);
		const events = (await asOwner('SELECT id FROM alert_event WHERE project_id = $1', [projectId])).map((r) => r.id);
		expect(events).not.toContain(oldCleared);
		expect(events).toEqual(expect.arrayContaining([newCleared, oldFiring]));
		const left = await asOwner('SELECT event_id, user_id, status FROM alert_delivery WHERE project_id = $1 ORDER BY status', [projectId]);
		expect(left).toEqual([
			{ event_id: newCleared, user_id: owner.id, status: 'digest' },
			{ event_id: oldFiring, user_id: editor.id, status: 'pending' }
		]);
		await asOwner('DELETE FROM alert_event WHERE project_id = $1', [projectId]);
	});

	it('refuses an age under 30 days', async () => {
		await expect(withoutUser((db) => db.query(`SELECT app_purge_alerts(interval '29 days')`))).rejects.toMatchObject({ code: '22023' });
	});
});
