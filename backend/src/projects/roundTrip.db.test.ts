// Round trips over the invented example catchments (scripts/examples): import a
// project file, download it (GET /projects/:id/export.json), import that
// download, and download again; or copy the project (POST /projects/:id/copy).
// Every field of the two downloads must agree, ids aside (docs/api.md
// § Projects, "Import a project file").
import { describe, expect, it } from 'vitest';
import { app, signUp } from '../__tests__/helpers.js';
import { buildExamples, buildRiverExample, type ExampleProject } from '../../scripts/examples/catchments.js';
import { buildShowcase } from '../../scripts/examples/showcase.js';
import type { ProjectDocument } from './document.js';

type User = Awaited<ReturnType<typeof signUp>>;

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The document with each id replaced by the order it first appears in (object
 * keys walked sorted), so two documents that differ only in their ids compare
 * equal. The download's time and its notes (never imported) are left out.
 */
function canonical(d: ProjectDocument): unknown {
	const seen = new Map<string, string>();
	const tag = (s: string) => {
		if (!seen.has(s)) seen.set(s, `#${seen.size}`);
		return seen.get(s)!;
	};
	const walk = (v: unknown): unknown => {
		if (typeof v === 'string') {
			// An id anywhere in a string: a bare one, a key that names a node after an '@' (a gauge's record, a unit's rain),
			// a kept check's or kept problem's item id (`outlier:<series>:…`, `problem:data:<series>`).
			return v.replace(UUID_IN, tag);
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v).sort()) out[typeof walk(k) === 'string' ? (walk(k) as string) : k] = walk((v as Record<string, unknown>)[k]);
			return out;
		}
		return v;
	};
	const { exportedAt: _at, notes: _notes, ...rest } = d;
	return walk(rest);
}

async function download(u: User, projectId: string): Promise<ProjectDocument> {
	const res = await app.request(`/projects/${projectId}/export.json`, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
	expect(res.status).toBe(200);
	return (await res.json()) as ProjectDocument;
}

async function importFile(u: User, file: unknown): Promise<string> {
	const { status, body } = await u.call('POST', '/projects/import', file);
	expect(status, JSON.stringify(body)).toBe(201);
	return body.project.id as string;
}

const examples: ExampleProject[] = [...buildExamples({ fit: false }), buildRiverExample({ fit: false }), buildShowcase({ fit: false })];

describe('project file round trips over the example catchments', () => {
	for (const ex of examples) {
		it(`${ex.name}: download → import → download changes nothing but ids`, async () => {
			const u = await signUp('RoundTrip');
			const first = await download(u, await importFile(u, ex));
			const second = await download(u, await importFile(u, first));
			expect(canonical(second)).toEqual(canonical(first));
		});

		it(`${ex.name}: a copy downloads as the original does`, async () => {
			const u = await signUp('Copy');
			const id = await importFile(u, ex);
			const first = await download(u, id);
			const { status, body } = await u.call('POST', `/projects/${id}/copy`, { name: first.name });
			expect(status, JSON.stringify(body)).toBe(201);
			const copy = await download(u, body.project.id);
			expect(canonical(copy)).toEqual(canonical(first));
		});
	}
});

describe('a kept Warnings-page problem about a series round-trips with the series', () => {
	it('download → import → download, and a copy, keep `problem:data:<id>` naming the same series', async () => {
		const u = await signUp('RoundTripKept');
		const base = buildExamples({ fit: false })[0]!;
		const sid = crypto.randomUUID();
		const series = base.series!.map((s, i) => (i === 0 ? { ...s, id: sid } : s));
		const file = { ...base, series, settings: { ...base.settings, warningsKept: [{ id: `problem:data:${sid}`, note: 'record ended' }] } };
		const keptSeries = (d: ProjectDocument) => {
			const id = ((d.settings.warningsKept as { id: string }[])[0]!.id).slice('problem:data:'.length);
			return d.series.find((s) => s.id === id);
		};
		const id = await importFile(u, file);
		const first = await download(u, id);
		expect(keptSeries(first)).toMatchObject({ kind: series[0]!.kind, name: series[0]!.name });
		const second = await download(u, await importFile(u, first));
		expect(keptSeries(second)).toMatchObject({ kind: series[0]!.kind, name: series[0]!.name });
		expect(canonical(second)).toEqual(canonical(first));
		const { body } = await u.call('POST', `/projects/${id}/copy`, { name: first.name });
		const copy = await download(u, body.project.id);
		expect(keptSeries(copy)).toMatchObject({ kind: series[0]!.kind, name: series[0]!.name });
		expect(canonical(copy)).toEqual(canonical(first));
	});
});
