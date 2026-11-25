// The outlet's name on what a farmer reads (docs/security.md § Publications and
// the farm view). The outflow node may be a farm: a farmer may read the gauges'
// names (public infrastructure, node_select_farmer) and their own farm's, never
// a neighbour's, so a published view whose outlet is a neighbour's farm names
// it to no farmer, nor to the WUA's "Preview as farmer". The share link already
// drops the outlet's name for the same reason (app_share_view, 115).
// Positive controls: a gauge site keeps its name, the staff's publication list
// keeps the outlet's, and a project whose outlet is a gauge names it.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User; // linked to Top farm only
let gaugeFarmer: User; // in the project whose outlet is a gauge
let projectId: string;
let gaugeProjectId: string;
const MARKER = `nbr${crypto.randomUUID().slice(0, 8)}`;
// The outlet is the neighbour's farm: the river leaves the catchment through it.
const bottom = { ...node(`Bottom ${MARKER}`, null), kind: 'farm' };
const gauge = node('Mid gauge', bottom.id, { kind: 'gauge' });
const top = node('Top farm', gauge.id);
const rain = Array.from({ length: 500 }, (_, i) => (i % 23 === 0 ? 12 : 0));

async function publishedProject(u: User, name: string, nodes: object[], farmIds: string[], farmerEmail: string): Promise<string> {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes, crops: [crop], cropAreas: farmIds.map((nodeId) => ({ nodeId, cropId: crop.id, areaM2: 200_000 })), transfers: [] };
	const put = await u.call('PUT', `/projects/${id}/model`, model);
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(3000) } })).status).toBe(200);
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	expect((await u.call('POST', `/projects/${id}/farmers`, { email: farmerEmail, nodeIds: [farmIds[0]] })).status).toBe(201);
	const run = await u.call('POST', `/projects/${id}/runs`, { label: 'r' });
	expect(run.status).toBe(201);
	expect((await u.call('POST', `/projects/${id}/publication`, { runId: run.body.run.id })).status).toBe(201);
	return id;
}

beforeAll(async () => {
	[owner, viewer, farmer, gaugeFarmer] = (await Promise.all(['Onowner', 'Onviewer', 'Onfarmer', 'Ongfarmer'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = await publishedProject(owner, 'Outlet is a farm', [bottom, gauge, top], [top.id, bottom.id], farmer.email);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	const weir = node('Sentinel weir', null);
	const only = node('Only farm', weir.id);
	gaugeProjectId = await publishedProject(owner, 'Outlet is a gauge', [weir, only], [only.id], gaugeFarmer.email);
}, 60_000);

describe('a published view whose outlet is a neighbour’s farm', () => {
	it('names it to the staff (positive control: the name is in the publication)', async () => {
		const res = await owner.call('GET', `/projects/${projectId}/publication`);
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).toContain(bottom.name);
	});

	it('never names it in the farmer’s farm view, and still names the gauge', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm/${top.id}`);
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).not.toContain(MARKER);
		expect(res.body.outlet30.name).toBe('');
		const names = (res.body.farm.river.sites as { name: string }[]).map((s) => s.name);
		expect(names).toContain('Mid gauge');
		expect(names).toContain('');
		// The site that set most of the charge is the outlet here: stored named, as published, and blanked for the farmer.
		const [stored] = await asOwner(
			`SELECT f.view->'river'->>'bindingSite' AS b FROM publication_farm f JOIN run_publication p ON p.id = f.publication_id
			 WHERE p.project_id = $1 AND p.superseded_at IS NULL AND f.node_id = $2`,
			[projectId, top.id]
		);
		expect(stored!.b).toBe(bottom.name);
		expect(res.body.farm.river.bindingSite).toBe('');
	});

	it('never names it in the farmer’s data export (positive control: the gauge is named there)', async () => {
		await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [farmer.id]);
		const res = await app.request('/auth/me/export', { headers: { cookie: farmer.cookie, origin: 'http://localhost:7777' } });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('Mid gauge');
		expect(text).not.toContain(MARKER);
	});

	it('never names it in the farmer’s publication list', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/publication`);
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).not.toContain(MARKER);
		const sites = res.body.current.catchmentView.sites as { name: string; isOutlet: boolean }[];
		expect(sites.find((s) => s.isOutlet)?.name).toBe('');
		expect(sites.map((s) => s.name)).toContain('Mid gauge');
	});

	it('nor in the WUA’s preview of the farm, which shows it as its farmer sees it', async () => {
		const res = await viewer.call('GET', `/projects/${projectId}/farm/${top.id}`);
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).not.toContain(MARKER);
		expect(res.body.outlet30.name).toBe('');
		expect((res.body.farm.river.sites as { name: string }[]).map((s) => s.name)).toContain('Mid gauge');
	});
});

describe('a published view whose outlet is a gauge (positive control)', () => {
	it('names the outlet to its farmer', async () => {
		const [farms] = [(await gaugeFarmer.call('GET', `/projects/${gaugeProjectId}/farm`)).body.farms as { nodeId: string }[]];
		const res = await gaugeFarmer.call('GET', `/projects/${gaugeProjectId}/farm/${farms[0]!.nodeId}`);
		expect(res.status).toBe(200);
		expect(res.body.outlet30.name).toBe('Sentinel weir');
		expect((res.body.farm.river.sites as { name: string }[]).map((s) => s.name)).toContain('Sentinel weir');
		const pub = await gaugeFarmer.call('GET', `/projects/${gaugeProjectId}/publication`);
		expect(pub.body.current.catchmentView.sites.find((s: { isOutlet: boolean }) => s.isOutlet)?.name).toBe('Sentinel weir');
	});
});
