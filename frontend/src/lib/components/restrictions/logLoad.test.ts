// The Restriction log's reads, answered out of order (docs/architecture.md § Stale responses).
import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api/index.js', () => ({ api: {} }));

import type { RestrictionDecision } from '#lib/api/index.js';
import { restrictionLogLoader, type LogPage } from './logLoad';

const page = (ids: string[], next: string | null = null): LogPage => ({ items: ids.map((id) => ({ id }) as unknown as RestrictionDecision), next });

describe('restrictionLogLoader', () => {
	it("drops another project's first page when it answers after this one's", async () => {
		const pending: { res: (v: LogPage) => void; rej: (e: unknown) => void }[] = [];
		const read = restrictionLogLoader(() => new Promise<LogPage>((res, rej) => pending.push({ res, rej })));
		const first = read('project-a', null);
		const second = read('project-b', null);
		pending[1]!.res(page(['b1']));
		expect(await second).toEqual({ current: true, value: page(['b1']) });
		pending[0]!.res(page(['a1']));
		expect(await first).toEqual({ current: false });
	});

	it('drops an older page still loading when the first page is read again, and its failure', async () => {
		const pending: { res: (v: LogPage) => void; rej: (e: unknown) => void }[] = [];
		const read = restrictionLogLoader(() => new Promise<LogPage>((res, rej) => pending.push({ res, rej })));
		const more = read('p', 'cursor-1');
		const again = read('p', null);
		pending[1]!.res(page(['new'], 'cursor-2'));
		expect(await again).toEqual({ current: true, value: page(['new'], 'cursor-2') });
		pending[0]!.res(page(['older']));
		expect(await more).toEqual({ current: false });

		const more2 = read('p', 'cursor-2');
		const again2 = read('p', null);
		pending[3]!.res(page(['newest']));
		expect(await again2).toEqual({ current: true, value: page(['newest']) });
		pending[2]!.rej(new Error('offline'));
		expect(await more2).toEqual({ current: false });
	});
});
