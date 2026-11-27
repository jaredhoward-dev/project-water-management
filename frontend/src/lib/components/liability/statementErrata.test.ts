// The validation statement's errata (issue #103): the run's server-provided ids win over this
// build's engine list, so a site older than the backend still lists the errata the backend knows.
import { ENGINE_ERRATA, validationStatement, type Erratum, type RunSummary } from '@water-management/engine';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { statementErrata } from './statementErrata';
import ValidationStatement from './ValidationStatement.svelte';

const erratum = (id: string, over: Partial<Erratum> = {}): Erratum => ({
	id,
	keyedOn: 'run',
	firstAffected: '0.30.0',
	fixedIn: '0.32.0',
	severity: 'High',
	appliesWhen: `when ${id} applies`,
	summary: `what ${id} gets wrong`,
	source: 'model.md §0',
	...over
});
const CATALOGUE = [erratum('ER-1'), erratum('ER-2', { fixedIn: null })];

const bare = {
	farms: [],
	catchment: { meanNaturalFlowM3Day: 1, meanSimulatedOutflowM3Day: 1, ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0 },
	calibration: null,
	warnings: []
} as unknown as RunSummary;

describe('statementErrata', () => {
	it('falls back to the engine’s list when the run carries no ids (an older API, or a route without them)', () => {
		for (const ids of [undefined, null]) expect(statementErrata([CATALOGUE[0]!], ids, CATALOGUE).map((e) => e.id), String(ids)).toEqual(['ER-1']);
		expect(statementErrata([CATALOGUE[0]!], undefined, CATALOGUE)[0]).toEqual({ id: 'ER-1', summary: 'what ER-1 gets wrong', appliesWhen: 'when ER-1 applies', fixedIn: '0.32.0', known: true });
	});

	it('takes the server’s ids over the engine’s list, described from this build’s catalogue', () => {
		// The engine says ER-1 alone; the server says ER-2: the server wins, with ER-2's own words.
		expect(statementErrata([CATALOGUE[0]!], ['ER-2'], CATALOGUE)).toEqual([{ id: 'ER-2', summary: 'what ER-2 gets wrong', appliesWhen: 'when ER-2 applies', fixedIn: null, known: true }]);
		// An empty list from the server is its word too: none apply.
		expect(statementErrata([CATALOGUE[0]!], [], CATALOGUE)).toEqual([]);
	});

	it('keeps an id this build doesn’t know (recorded after it was built), named but not described', () => {
		const rows = statementErrata([], ['ER-1', 'ER-77', 'ER-77'], CATALOGUE);
		expect(rows.map((e) => [e.id, e.known])).toEqual([
			['ER-1', true],
			['ER-77', false]
		]);
		expect(rows[1]).toEqual({ id: 'ER-77', summary: null, appliesWhen: null, fixedIn: null, known: false });
	});

	it('describes from the generated errata by default', () => {
		const first = ENGINE_ERRATA[0]!;
		expect(statementErrata([], [first.id])[0]).toMatchObject({ id: first.id, summary: first.summary, known: true });
	});
});

describe('ValidationStatement’s errata table', () => {
	// Engine 0.0.1 has errata in the generated list (ER-1 was open from 0.0.0), so the fallback has rows to show.
	const engineVersion = '0.0.1';
	const engineIds = validationStatement({ summary: bare, engineVersion, legacy: false }).errata.map((e) => e.id);
	const table = (errata?: string[]) => {
		const { body } = render(ValidationStatement, { props: { summary: bare, engineVersion, legacy: false, errata } });
		const rows = [...body.matchAll(/<tr( data-erratum-unknown(?:="")?)?><th scope="row">(ER-\d+)<\/th>/g)].map((m) => [m[2], m[1] ? 'unknown' : 'known']);
		return { body, rows };
	};

	it('without server ids, lists the engine’s own errata for the version (positive control)', () => {
		expect(engineIds.length).toBeGreaterThan(0);
		expect(table().rows.map((r) => r[0])).toEqual(engineIds);
	});

	it('with server ids, lists exactly those, including one newer than this build', () => {
		const known = ENGINE_ERRATA[ENGINE_ERRATA.length - 1]!.id;
		const { body, rows } = table([known, 'ER-9999']);
		expect(rows).toEqual([
			[known, 'known'],
			['ER-9999', 'unknown']
		]);
		expect(body).toContain('Recorded after this page was built');
	});

	it('with an empty server list, says none are recorded', () => {
		const { body, rows } = table([]);
		expect(rows).toEqual([]);
		expect(body).toContain('None recorded for this engine version');
	});
});
