// The WUA's name on the farm index and view (095_wua_name), the run's first
// date on the projection (`dataFrom`), who reads the farm view, and the farm
// series and history routes removed on 2026-11-25. Two farms in a line, as in
// series-privacy.db.test.ts; the farmer is linked to Down only.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let farmer: User; // linked to Down only
let stranger: User;
let projectId: string;
const outlet = node('Outlet weir', null);
const down = node('Lower farm', outlet.id, { damCapacityM3: 50_000 });
const up = node('Upper neighbour', down.id, { damCapacityM3: 80_000 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const RAIN_START = '2021-10-01';
const DAYS = 500; // to 2023-02-12

const runAndPublish = async (extra: Record<string, unknown> = {}) => {
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' });
	expect(run.status).toBe(201);
	const pub = await owner.call('POST', `/projects/${projectId}/publication`, { runId: run.body.run.id, ...extra });
	expect(pub.status).toBe(201);
	return run.body.run.id as string;
};
let firstRun: string;
let currentRun: string;

beforeAll(async () => {
	[owner, farmer, stranger] = (await Promise.all([signUp('Hisowner'), signUp('Hisfarmer'), signUp('Hisstranger')])) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Farm history' })).body.project.id;
	const model = {
		nodes: [outlet, down, up],
		crops: [crop],
		cropAreas: [
			{ nodeId: down.id, cropId: crop.id, areaM2: 120_000 },
			{ nodeId: up.id, cropId: crop.id, areaM2: 150_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(2000) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 7 === 0 ? 30 : i % 3 === 0 ? 4 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: RAIN_START, values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [down.id] })).status).toBe(201);
	firstRun = await runAndPublish();
	currentRun = await runAndPublish({ restriction: { level: 'advisory', pct: 10, notice: { en: 'Please save water.' } } });
}, 60_000);

describe('the WUA’s name (095_wua_name)', () => {
	it('is null until an editor names it, then the farm index and view carry it, trimmed', async () => {
		expect((await farmer.call('GET', `/projects/${projectId}/farm`)).body.project).toEqual({ id: projectId, name: 'Farm history', wuaName: null });
		const set = await owner.call('PATCH', `/projects/${projectId}`, { wuaName: '  Vaalbank WUA ' });
		expect(set.status).toBe(200);
		expect(set.body.project.wuaName).toBe('Vaalbank WUA');
		expect((await farmer.call('GET', `/projects/${projectId}/farm`)).body.project.wuaName).toBe('Vaalbank WUA');
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.project.wuaName).toBe('Vaalbank WUA');
		// An audit event names the change.
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'project.changed' ORDER BY created_at DESC, id DESC LIMIT 1`, [projectId]);
		expect(ev.subject).toMatchObject({ fields: ['wua_name'], wuaName: { from: null, to: 'Vaalbank WUA' } });
	});

	it('clears on an empty name, and only an editor may change it (a farmer can’t)', async () => {
		expect((await farmer.call('PATCH', `/projects/${projectId}`, { wuaName: 'Not mine' })).status).toBe(403);
		expect((await owner.call('PATCH', `/projects/${projectId}`, { wuaName: '' })).body.project.wuaName).toBeNull();
		expect((await owner.call('PATCH', `/projects/${projectId}`, { wuaName: 'x'.repeat(201) })).status).toBe(400);
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.project.wuaName).toBeNull();
	});
});

describe('the run’s first date on the projection (dataFrom)', () => {
	it('is on a new publication’s farm view, and filled from the catchment view on one stored before it', async () => {
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.farm.dataFrom).toBe(RAIN_START);
		// A projection stored before the field existed.
		await asOwner(
			`UPDATE publication_farm f SET view = f.view - 'dataFrom'
			 FROM run_publication p WHERE p.id = f.publication_id AND p.run_id = $1 AND f.node_id = $2`,
			[currentRun, down.id]
		);
		const [stored] = await asOwner(
			`SELECT f.view ? 'dataFrom' AS has FROM publication_farm f JOIN run_publication p ON p.id = f.publication_id WHERE p.run_id = $1 AND f.node_id = $2`,
			[currentRun, down.id]
		);
		expect(stored.has).toBe(false);
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`)).body.farm.dataFrom).toBe(RAIN_START);
		expect(firstRun).not.toBe(currentRun);
	});
});

describe('who reads the farm view (kept from the removed farm-history.db.test.ts)', () => {
	it('404s the neighbour’s farm, a gauge, an unknown id and a stranger; the farmer reads their own, the owner the neighbour (positive controls)', async () => {
		for (const n of [up.id, outlet.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
			expect((await farmer.call('GET', `/projects/${projectId}/farm/${n}`)).status, n).toBe(404);
		}
		expect((await stranger.call('GET', `/projects/${projectId}/farm/${down.id}`)).status).toBe(404);
		const own = await farmer.call('GET', `/projects/${projectId}/farm/${down.id}`);
		expect(own.status).toBe(200);
		const text = JSON.stringify(own.body);
		expect(text).not.toContain(up.id);
		expect(text).not.toContain(up.name);
		expect((await owner.call('GET', `/projects/${projectId}/farm/${up.id}`)).status).toBe(200);
	});
});

describe('the removed farm series and history routes (2026-11-25, no caller)', () => {
	it('answer 404 to members who can see the farm, whose farm view answers 200 (positive control)', async () => {
		for (const [who, nodeId] of [
			[owner, up.id],
			[owner, down.id],
			[farmer, down.id]
		] as const) {
			const at = `/projects/${projectId}/farm/${nodeId}`;
			expect((await who.call('GET', at)).status, at).toBe(200);
			for (const path of ['/series?key=supplied', '/history']) {
				expect((await who.call('GET', `${at}${path}`)).status, `${at}${path}`).toBe(404);
			}
		}
	});
});
