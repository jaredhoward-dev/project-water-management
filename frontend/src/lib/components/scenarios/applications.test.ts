import { describe, expect, it } from 'vitest';
import type { Scenario } from '#lib/api/types.js';
import {
	applicationsViewHeading,
	applicationConflictText,
	applicationCounts,
	applicationsContext,
	daysSince,
	daysText,
	filterApplications,
	longestWaiting,
	parseFilter,
	parseSort,
	rereadAfterConflict,
	sortApplications,
	statusPill
} from './applications';

const app = (id: string, status: Scenario['status'], submittedAt: string | null, name = id): Scenario =>
	({ id, name, status, submittedAt, updatedAt: '2026-01-01T00:00:00.000Z' }) as Scenario;

const items = [
	app('a', 'decided', '2026-03-01T08:00:00.000Z'),
	app('b', 'submitted', '2026-04-01T08:00:00.000Z'),
	app('c', 'submitted', '2026-02-01T08:00:00.000Z'),
	app('d', 'withdrawn', '2026-05-01T08:00:00.000Z')
];

describe('sortApplications', () => {
	it('by date: newest submission first', () => {
		expect(sortApplications(items, 'date').map((a) => a.id)).toEqual(['d', 'b', 'a', 'c']);
	});

	it('by status: the queue awaiting a decision first, longest-waiting on top', () => {
		expect(sortApplications(items, 'status').map((a) => a.id)).toEqual(['c', 'b', 'd', 'a']);
	});

	it('leaves the input alone and breaks ties by name', () => {
		const same = [app('y', 'submitted', '2026-02-01T08:00:00.000Z', 'Zulu'), app('x', 'submitted', '2026-02-01T08:00:00.000Z', 'Alpha')];
		expect(sortApplications(same, 'date').map((a) => a.name)).toEqual(['Alpha', 'Zulu']);
		expect(same.map((a) => a.id)).toEqual(['y', 'x']);
	});
});

describe('the sort in the URL', () => {
	it('reads ?sort=status, and anything else as newest first', () => {
		expect(parseSort('status')).toBe('status');
		expect(parseSort(null)).toBe('date');
		expect(parseSort('date')).toBe('date');
		expect(parseSort('name')).toBe('date');
	});
});

describe('the status filter and counts', () => {
	it('reads only the known values from the URL', () => {
		expect(parseFilter('awaiting')).toBe('awaiting');
		expect(parseFilter('withdrawn')).toBe('withdrawn');
		expect(parseFilter(null)).toBe('all');
		expect(parseFilter('draft')).toBe('all');
	});

	it('keeps one status, or all of them', () => {
		expect(filterApplications(items, 'awaiting').map((a) => a.id)).toEqual(['b', 'c']);
		expect(filterApplications(items, 'decided').map((a) => a.id)).toEqual(['a']);
		expect(filterApplications(items, 'all')).toHaveLength(4);
		expect(applicationCounts(items)).toEqual({ all: 4, awaiting: 2, decided: 1, withdrawn: 1 });
	});
});

describe('waiting and the header line', () => {
	const now = Date.parse('2026-04-11T09:00:00.000Z');

	it('counts whole days since the submission', () => {
		expect(daysSince('2026-04-11T08:00:00.000Z', now)).toBe(0);
		expect(daysSince('2026-04-10T09:00:00.000Z', now)).toBe(1);
		expect(daysSince('2026-02-01T08:00:00.000Z', now)).toBe(69);
		expect(daysText(0)).toBe('less than a day');
		expect(daysText(1)).toBe('1 day');
		expect(daysText(69)).toBe('69 days');
	});

	it('names the one waiting longest, never a decided or withdrawn one', () => {
		expect(longestWaiting(items)?.id).toBe('c');
		expect(longestWaiting([items[0]!, items[3]!])).toBeNull();
	});

	it('says how many there are and how many wait, and for how long', () => {
		expect(applicationsContext(items, now)).toBe('4 applications · 2 awaiting a decision, the longest for 69 days');
		expect(applicationsContext([items[0]!], now)).toBe('1 application · none awaiting a decision');
		expect(applicationsContext([], now)).toBe('No applications submitted yet');
	});
});

describe('statusPill', () => {
	it('puts the outcome in words, with a tone for each', () => {
		expect(statusPill({ status: 'submitted', outcome: null })).toEqual({ text: 'Awaiting a decision', tone: 'awaiting' });
		expect(statusPill({ status: 'decided', outcome: 'licence_issued' })).toEqual({ text: 'Licence issued (see its conditions)', tone: 'good' });
		expect(statusPill({ status: 'decided', outcome: 'licence_refused' })).toEqual({ text: 'Licence refused', tone: 'bad' });
		expect(statusPill({ status: 'decided', outcome: 'application_rejected' })).toEqual({ text: 'Application rejected (formal requirements)', tone: 'bad' });
		expect(statusPill({ status: 'decided', outcome: 'not_considered' })).toEqual({ text: 'Not considered: use already authorised', tone: 'mixed' });
		expect(statusPill({ status: 'withdrawn', outcome: null })).toEqual({ text: 'Withdrawn', tone: 'neutral' });
	});
});

describe('rereadAfterConflict', () => {
	const conflict = Object.assign(new Error("this scenario is decided; it can't become withdrawn"), { status: 409 });
	it('reads the application again after a 409, so the panel shows where it stands', async () => {
		let reads = 0;
		expect(await rereadAfterConflict(conflict, async () => (reads++, 'fresh'))).toBe('fresh');
		expect(reads).toBe(1);
	});
	it('reads nothing on any other refusal, and gives null when the read fails', async () => {
		let reads = 0;
		const read = async () => (reads++, 'fresh');
		expect(await rereadAfterConflict(Object.assign(new Error('nope'), { status: 400 }), read)).toBeNull();
		expect(await rereadAfterConflict(new Error('network'), read)).toBeNull();
		expect(await rereadAfterConflict(null, read)).toBeNull();
		expect(reads).toBe(0);
		expect(
			await rereadAfterConflict(conflict, async () => {
				throw new Error('offline');
			})
		).toBeNull();
	});
});

describe('applicationConflictText', () => {
	it('composes one sentence, the server’s words in brackets (issue #934)', () => {
		const t = applicationConflictText("a withdrawn scenario can't become submitted");
		expect(t).toBe(
			"The application changed since this page read it, so the move was refused (a withdrawn scenario can't become submitted); someone else may have withdrawn, reopened or decided it, and it now shows where it stands."
		);
		// One sentence: a capital first, one full stop, at the end.
		expect(t.match(/\./g)).toHaveLength(1);
		expect(t).not.toContain('. ');
	});
	it('drops a trailing stop from the server’s words, and the brackets when there are none', () => {
		expect(applicationConflictText('already decided. ')).toContain('(already decided);');
		expect(applicationConflictText('  ')).toBe(
			'The application changed since this page read it, so the move was refused; someone else may have withdrawn, reopened or decided it, and it now shows where it stands.'
		);
	});
});

describe('applicationsViewHeading', () => {
	it('lands on the new view’s heading when the view switches, and nowhere otherwise', () => {
		expect(applicationsViewHeading(false, true)).toBe('assess-h');
		expect(applicationsViewHeading(true, false)).toBe('applications-h');
		// The first render and a step that keeps the view (a sort, a filter) keep the place.
		expect(applicationsViewHeading(null, true)).toBeNull();
		expect(applicationsViewHeading(false, false)).toBeNull();
		expect(applicationsViewHeading(true, true)).toBeNull();
	});
});
