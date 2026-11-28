// RecentNotes' reads, answered out of order (docs/architecture.md § Stale responses).
import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api/index.js', () => ({ api: {} }));

import type { Note } from '#lib/api/index.js';
import { recentNotesLoader } from './recentLoad';

const note = (id: string) => ({ id, body: id }) as unknown as Note;

describe('recentNotesLoader (a note changed while the list still loads)', () => {
	it('drops the earlier read, and its failure, when they answer after the later one', async () => {
		const pending: { res: (v: Note[]) => void; rej: (e: unknown) => void }[] = [];
		const read = recentNotesLoader(() => new Promise<Note[]>((res, rej) => pending.push({ res, rej })));
		const first = read('p', 8);
		const second = read('p', 8);
		// The later read (after a note was added) has it; the earlier one doesn't.
		pending[1]!.res([note('added'), note('old')]);
		expect(await second).toEqual({ current: true, value: [note('added'), note('old')] });
		pending[0]!.res([note('old')]);
		expect(await first).toEqual({ current: false });

		const third = read('p', 8);
		const fourth = read('p', 8);
		pending[3]!.res([note('new')]);
		expect(await fourth).toEqual({ current: true, value: [note('new')] });
		pending[2]!.rej(new Error('offline'));
		expect(await third).toEqual({ current: false });
	});
});
