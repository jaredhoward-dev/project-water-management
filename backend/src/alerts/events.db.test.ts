// GET /projects/:id/alert-events (alerts/routes.ts): who may list a catchment's alert events and what the list
// carries. A contributor (an applicant's consultant) gets an empty list, a stranger a 404; the default is the
// firing events and `?state=all` adds the cleared ones, newest first; a restriction event's `signature` (the
// evaluator's own change detector, evaluate.ts) never leaves the server. Positive control: a viewer sees them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let contributor: User;
let stranger: User;
let projectId: string;
let firingId: string;
let clearedId: string;

const list = (u: User, query = '') => u.call('GET', `/projects/${projectId}/alert-events${query}`);

beforeAll(async () => {
	[owner, viewer, contributor, stranger] = (await Promise.all(['Evowner', 'Evviewer', 'Evcontrib', 'Evstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Alert events' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: contributor.email, role: 'contributor' })).status).toBe(201);
	const [jobRule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'job_dead', 1) RETURNING id`, [projectId]);
	const [noticeRule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'restriction_published', 0) RETURNING id`, [projectId]);
	[{ id: clearedId }] = await asOwner(
		// Inserted first, so it is the older (alert_event_guard stamps opened_at with now()).
		`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 0, $3) RETURNING id`,
		[noticeRule.id, projectId, JSON.stringify({ level: 'none', pct: null, lifted: true, signature: 'none||Water is short', publicationId: crypto.randomUUID() })]
	);
	[{ id: firingId }] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'firing', 2, '{"count":2}') RETURNING id`, [
		jobRule.id,
		projectId
	]);
});

afterAll(async () => {
	await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [projectId]);
});

describe('GET /projects/:id/alert-events', () => {
	it('lists the firing events by default, and the cleared ones too with state=all, newest first (a viewer: positive control)', async () => {
		const firing = await list(viewer);
		expect(firing.status).toBe(200);
		expect(firing.body.events.map((e: { id: string }) => e.id)).toEqual([firingId]);
		expect(firing.body.events[0]).toMatchObject({ kind: 'job_dead', state: 'firing', value: 2, threshold: 1, clearedAt: null, detail: { count: 2 } });
		const all = await list(viewer, '?state=all');
		expect(all.body.events.map((e: { id: string }) => e.id)).toEqual([firingId, clearedId]);
	});

	it('never sends a restriction event’s signature, though the rest of its detail goes', async () => {
		const events = (await list(owner, '?state=all')).body.events as { id: string; detail: Record<string, unknown> }[];
		const notice = events.find((e) => e.id === clearedId)!;
		expect(notice.detail).toMatchObject({ level: 'none', lifted: true });
		expect(notice.detail).not.toHaveProperty('signature');
		expect(JSON.stringify(events)).not.toContain('Water is short');
	});

	it('gives a contributor an empty list, and a stranger a 404', async () => {
		const c = await list(contributor, '?state=all');
		expect(c.status).toBe(200);
		expect(c.body.events).toEqual([]);
		expect((await list(stranger)).status).toBe(404);
	});

	it('refuses a state it does not know', async () => {
		expect((await list(owner, '?state=cleared')).status).toBe(400);
	});
});
