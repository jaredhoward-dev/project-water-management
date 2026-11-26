import { describe, expect, it } from 'vitest';
import type { Run, RunMeta } from '#lib/api/index.js';
import { ApiError } from '#lib/api/client.js';
import { elapsedSeconds, failureForPage, inFlightFor, withCreatedRun, type RunInFlight } from './runInFlight';
import { RUN_GONE } from './runList';

const meta = (id: string) => ({ id, label: id }) as unknown as RunMeta;
const created = (id: string, removedRunIds: string[] = []) => ({ run: { ...meta(id), summary: { days: 1 } } as unknown as Run, removedRunIds });

describe('withCreatedRun', () => {
	it('puts the new run first, without its summary', () => {
		const next = withCreatedRun([meta('a'), meta('b')], created('c'));
		expect(next.map((r) => r.id)).toEqual(['c', 'a', 'b']);
		expect('summary' in next[0]!).toBe(false);
	});
	it('drops the runs the server trimmed', () => {
		expect(withCreatedRun([meta('a'), meta('b')], created('c', ['b'])).map((r) => r.id)).toEqual(['c', 'a']);
	});
	it('gives the same list applied twice (the tab that started the run and the one that came back)', () => {
		const once = withCreatedRun([meta('a')], created('c'));
		expect(withCreatedRun(once, created('c')).map((r) => r.id)).toEqual(['c', 'a']);
	});
});

describe('elapsedSeconds', () => {
	it('counts whole seconds since the start', () => {
		expect(elapsedSeconds(1000, 1999)).toBe(0);
		expect(elapsedSeconds(1000, 4500)).toBe(3);
	});
	it('never goes below 0 when the clock steps back', () => {
		expect(elapsedSeconds(5000, 1000)).toBe(0);
	});
});

describe('inFlightFor', () => {
	const flight: RunInFlight = { projectId: 'p1', startedAt: 0, done: new Promise(() => {}) };
	it("shows this project's run", () => {
		expect(inFlightFor(flight, 'p1')).toBe(flight);
	});
	it("never another project's run, nor none", () => {
		expect(inFlightFor(flight, 'p2')).toBeNull();
		expect(inFlightFor(null, 'p1')).toBeNull();
	});
});

describe('failureForPage', () => {
	const flight: RunInFlight = { projectId: 'p1', startedAt: 0, done: new Promise(() => {}) };
	it("says nothing while the project's Runs & results is open: the tab says it", () => {
		expect(failureForPage(flight, new Error('Engine failed'), { projectId: 'p1', tab: 'runs' })).toBeNull();
	});
	it('names the failure on another tab of the project', () => {
		expect(failureForPage(flight, new Error('Engine failed'), { projectId: 'p1', tab: 'network' })).toEqual({ projectId: 'p1', text: 'Engine failed' });
	});
	it("keeps it for the run's project when another project is open, even on its Runs & results", () => {
		expect(failureForPage(flight, 'boom', { projectId: 'p2', tab: 'runs' })).toEqual({ projectId: 'p1', text: 'boom' });
	});
	it('says a gone run in words, not the bare not found', () => {
		expect(failureForPage(flight, new ApiError(404, 'not found'), { projectId: 'p1', tab: 'overview' })?.text).toBe(RUN_GONE);
	});
});
