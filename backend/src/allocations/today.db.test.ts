// "In force today" is the catchment's day (project.time_zone, 058), not UTC's
// (docs/allocations.md § Who sees what). A viewer kept from each volume reads
// today's total per water source (volumeTotals); between midnight and 02:00 in
// South Africa UTC's date is still yesterday, so a volume that started today
// was left out of it and one that lapsed yesterday was still counted. The farm
// view and the editors' Registered users table already count to the local day.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** The UTC calendar date `days` after `iso`. */
const plusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe('a viewer’s totals in force today count to the catchment’s day, not UTC’s', () => {
	let owner: User;
	let editor: User;
	let viewer: User;
	let pid: string;
	// 23:30 UTC is 01:30 the next day in Africa/Johannesburg (UTC+2, the project's default zone). Later today in UTC, so
	// the sessions signed now stay valid.
	const utcDay = new Date().toISOString().slice(0, 10);
	const localDay = plusDays(utcDay, 1);
	const at = new Date(`${utcDay}T23:30:00Z`);
	const VOL = 100_000;
	const LAPSED = 7_000;

	beforeAll(async () => {
		[owner, editor, viewer] = (await Promise.all(['Towner', 'Teditor', 'Tviewer'].map((n) => signUp(n)))) as [User, User, User];
		pid = (await owner.call('POST', '/projects', { name: 'Today where the catchment is' })).body.project.id;
		const weir = node('Weir', null);
		const units = ['T1', 'T2', 'T3', 'T4', 'T5'].map((n) => node(n, weir.id));
		expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [weir, ...units], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const)
			expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
		const add = async (body: Record<string, unknown>) => {
			const res = await editor.call('POST', `/projects/${pid}/allocations`, { authorisation: 'licence', waterSource: 'surface', ...body });
			expect(res.status, JSON.stringify(res.body)).toBe(201);
		};
		// Five holders whose licences start on the catchment's today (UTC's tomorrow).
		for (const [i, u] of units.entries()) await add({ nodeId: u.id, holder: `Today Holder ${i + 1}`, volumeM3PerYear: VOL, validFrom: localDay });
		// And one that lapsed at the end of UTC's today, the catchment's yesterday.
		await add({ nodeId: units[0]!.id, holder: 'Lapsed Holder', volumeM3PerYear: LAPSED, validTo: utcDay });
	}, 60_000);

	afterEach(() => vi.useRealTimers());

	it('counts the volumes that started on the catchment’s today and not the one that lapsed on its yesterday', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at);
		const res = await viewer.call('GET', `/projects/${pid}/allocations`);
		expect(res.status).toBe(200);
		expect(res.body.unitsHidden).toBe(true);
		expect(res.body.totals).toEqual([{ waterSource: 'surface', holders: 6, registeredM3PerYear: 5 * VOL, storageM3: null }]);
	});

	it('positive control: at noon UTC the same day both clocks agree, and only the lapsing volume is in force', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(`${utcDay}T12:00:00Z`));
		const res = await viewer.call('GET', `/projects/${pid}/allocations`);
		// One holder's volume alone in force: withheld (#523 G), never LAPSED.
		expect(res.body.totals).toEqual([{ waterSource: 'surface', holders: 6, registeredM3PerYear: null, storageM3: null }]);
	});
});
