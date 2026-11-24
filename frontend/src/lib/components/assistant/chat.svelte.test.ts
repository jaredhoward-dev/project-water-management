// The assistant's conversation (issue #610): a turn streams text, tool lines
// and proposals; the conversation sent leaves out unanswered questions; a
// refusal before the stream (the hourly limit, the budget, a dollar cap) puts the question
// back; Stop keeps what came. Runs with the client runtime (a .svelte.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import type { AssistantDayMeter, AssistantProposal, AssistantRequest, AssistantStatus, AssistantStreamEvent } from '#lib/api/types.js';
import { AssistantChat, DOLLAR_CAP_CODES, MAX_SENT_MESSAGES, applicable, capMessages, capOffersPlans, dayMeterText, waitText, type AssistantTurn, type Refusal } from './chat.svelte';
import { ChatHistory, type ChatRecord, type HistoryBackend } from './history';

const STATUS: AssistantStatus = {
	available: true,
	provider: 'mock',
	canApply: true,
	budget: { tokensPerMonth: 1000, tokensUsed: 100, resetsAt: '2026-11-01T00:00:00Z', scope: 'project' },
	rate: { messagesPerHour: 30 },
	disclaimer: 'Advice, not model output.'
};

const sse = (events: AssistantStreamEvent[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function streamOf(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(c) {
			c.enqueue(bytes);
			c.close();
		}
	});
}

function chatWith(send: (body: AssistantRequest, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>, status: AssistantStatus = STATUS, later?: (fn: () => void, ms: number) => void) {
	const c = new AssistantChat({ status: async () => structuredClone(status), send, later });
	return c;
}

const PROPOSAL: AssistantProposal = {
	goal: 'recalibration',
	title: 'Recalibration: GR4J X1',
	changes: [{ label: 'GR4J X1', lines: ['GR4J X1: 350 → 420'], reason: 'A larger store damps the response.' }],
	apply: { kind: 'settings', patch: { gr4j: { x1: 420 } } }
};

describe('AssistantChat', () => {
	it('is available only once the status says so, and hides on a status it can’t read', async () => {
		const on = chatWith(async () => streamOf(''));
		expect(on.available).toBe(false);
		await on.load();
		expect(on.available).toBe(true);
		expect(on.canApply).toBe(true);
		expect(on.tokensLeft).toBe(900);

		const off = new AssistantChat({ status: async () => ({ available: false }), send: async () => streamOf('') });
		await off.load();
		expect(off.available).toBe(false);
		const failed = new AssistantChat({ status: async () => Promise.reject(new ApiError(403, 'no')), send: async () => streamOf('') });
		await failed.load();
		expect(failed.status).toEqual({ available: false });
	});

	it('streams a turn: tool lines started and finished, the text, a proposal, and the budget from usage', async () => {
		const send = vi.fn(async (_body: AssistantRequest, _signal: AbortSignal) =>
			streamOf(
				sse([
					{ type: 'tool', name: 'get_network', label: 'Reading the network', status: 'start' },
					{ type: 'tool', name: 'get_network', label: 'Reading the network', status: 'done' },
					{ type: 'tool', name: 'get_gauge_fit', label: 'Scoring the fit', status: 'start' },
					{ type: 'tool', name: 'get_gauge_fit', label: 'Scoring the fit', status: 'error' },
					{ type: 'text', delta: 'The gauge ' },
					{ type: 'text', delta: 'is fed by a dam.' },
					{ type: 'proposal', proposal: PROPOSAL },
					{ type: 'usage', inputTokens: 50, outputTokens: 20, tokensUsed: 170, tokensPerMonth: 1000, scope: 'project' },
					{ type: 'done' }
				])
			)
		);
		const c = chatWith(send);
		await c.load();
		expect(await c.ask('  Why no response?  ', 'run-1')).toBe(true);
		expect(send).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'Why no response?' }], runId: 'run-1' }, expect.any(AbortSignal));
		expect(c.busy).toBe(false);
		const t = c.turns[1] as AssistantTurn;
		expect(t.tools).toEqual([
			{ name: 'get_network', label: 'Reading the network', status: 'done' },
			{ name: 'get_gauge_fit', label: 'Scoring the fit', status: 'error' }
		]);
		expect(t.text).toBe('The gauge is fed by a dam.');
		expect(t.proposals).toEqual([{ proposal: PROPOSAL, applied: false }]);
		expect(t.done).toBe(true);
		expect(t.error).toBeNull();
		expect(c.tokensLeft).toBe(830);
	});

	it('sends the whole conversation each turn, leaving out a question that got no answer', async () => {
		let reply: AssistantStreamEvent[] = [{ type: 'text', delta: 'First answer.' }, { type: 'done' }];
		const send = vi.fn(async (_body: AssistantRequest, _signal: AbortSignal) => streamOf(sse(reply)));
		const c = chatWith(send);
		await c.load();
		await c.ask('One?');
		reply = [{ type: 'error', code: 'assistant_failed', error: 'The model had a problem.' }];
		await c.ask('Two?');
		expect((c.turns[3] as AssistantTurn).error).toBe('The model had a problem.');
		reply = [{ type: 'text', delta: 'Third answer.' }, { type: 'done' }];
		await c.ask('Three?');
		expect(send.mock.lastCall![0]).toEqual({
			messages: [
				{ role: 'user', content: 'One?' },
				{ role: 'assistant', content: 'First answer.' },
				{ role: 'user', content: 'Three?' }
			]
		});
	});

	it('says so when the stream ends without its done', async () => {
		const c = chatWith(async () => streamOf(sse([{ type: 'text', delta: 'Half' }])));
		await c.load();
		await c.ask('Q');
		expect((c.turns[1] as AssistantTurn).error).toMatch(/stopped before it finished/);
	});

	it('a 429 before the stream: the question isn’t taken, the wait is shown, and lifts after Retry-After', async () => {
		const timers: { fn: () => void; ms: number }[] = [];
		const c = chatWith(
			async () => Promise.reject(new ApiError(429, 'Too many messages', undefined, 'assistant_rate_limited', { retryAfter: 120, seconds: 120 })),
			STATUS,
			(fn, ms) => timers.push({ fn, ms })
		);
		await c.load();
		expect(await c.ask('Q')).toBe(false);
		expect(c.turns).toEqual([]);
		expect(c.refusal).toEqual({ kind: 'rate', seconds: 120, message: 'Too many messages' });
		// Nothing more goes while it holds.
		expect(timers).toHaveLength(1);
		expect(timers[0]!.ms).toBe(120_000);
		timers[0]!.fn();
		expect(c.refusal).toBeNull();
	});

	it('a 429 without the assistant’s rate code (a WAF block, say) is an error, not the hourly limit', async () => {
		const c = chatWith(async () => Promise.reject(new ApiError(429, 'Too many requests', undefined, null, { retryAfter: 30 })), STATUS);
		await c.load();
		expect(await c.ask('Q')).toBe(false);
		expect(c.refusal).toEqual({ kind: 'error', message: 'Too many requests' });
	});

	it('Free’s verified-email gate (403 email_unverified or email_disposable) is its own refusal, and the box stays open', async () => {
		for (const code of ['email_unverified', 'email_disposable'] as const) {
			const c = chatWith(async () => Promise.reject(new ApiError(403, 'Verify your email', undefined, code)), STATUS);
			await c.load();
			expect(await c.ask('Q')).toBe(false);
			expect(c.refusal).toEqual({ kind: 'email', code });
			expect(c.capped).toBe(false);
			expect(c.spent).toBe(false);
		}
	});

	it('the month’s budget spent: refused before the stream (by code) or as the status says, and nothing is sent', async () => {
		const send = vi.fn(async (_body: AssistantRequest, _signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => Promise.reject(new ApiError(429, 'Budget spent', undefined, 'assistant_budget_spent')));
		const c = chatWith(send);
		await c.load();
		expect(await c.ask('Q')).toBe(false);
		expect(c.refusal).toMatchObject({ kind: 'budget', scope: 'project' });
		expect(c.spent).toBe(true);
		expect(c.spentScope).toBe('project');
		expect(await c.ask('Again')).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);

		const used = chatWith(send, { ...STATUS, budget: { ...STATUS.budget, tokensUsed: 1000 } } as AssistantStatus);
		await used.load();
		expect(used.spent).toBe(true);
		expect(used.spentScope).toBe('project');
		expect(await used.ask('Q')).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('names whose month is spent: the person’s across projects, or the server’s, by the refusal’s code', async () => {
		for (const [code, scope] of [
			['assistant_user_budget_spent', 'user'],
			['assistant_total_budget_spent', 'total']
		] as const) {
			const send = vi.fn(async (): Promise<ReadableStream<Uint8Array>> => Promise.reject(new ApiError(429, 'Spent', undefined, code)));
			const c = chatWith(send);
			await c.load();
			expect(await c.ask('Q')).toBe(false);
			expect(c.refusal).toMatchObject({ kind: 'budget', scope });
			expect(c.spentScope).toBe(scope);
			expect(await c.ask('Again')).toBe(false);
			expect(send).toHaveBeenCalledTimes(1);
		}
		// The status's own cap when it is the one used up.
		const used = chatWith(vi.fn(), { ...STATUS, budget: { ...STATUS.budget, tokensUsed: 1000, scope: 'user' } } as AssistantStatus);
		await used.load();
		expect(used.spentScope).toBe('user');
	});

	describe('the dollar caps (billing enforced): refused before the stream, the server’s words kept, lifted once back', () => {
		const resetsIn = (s: number) => new Date(Date.now() + s * 1000).toISOString();
		for (const code of DOLLAR_CAP_CODES) {
			it(code, async () => {
				const timers: { fn: () => void; ms: number }[] = [];
				const resetsAt = resetsIn(3600);
				const send = vi.fn(async (): Promise<ReadableStream<Uint8Array>> =>
					Promise.reject(new ApiError(429, `Words for ${code}`, undefined, code, { seconds: 3600, resetsAt }))
				);
				const c = chatWith(send, STATUS, (fn, ms) => timers.push({ fn, ms }));
				await c.load();
				expect(await c.ask('Q')).toBe(false);
				expect(c.turns).toEqual([]);
				expect(c.refusal).toEqual({ kind: 'cap', code, seconds: expect.any(Number), resetsAt, message: `Words for ${code}`, plan: null });
				expect(c.capped).toBe(true);
				// Not the token budget's refusal: no budget scope is named.
				expect(c.spentScope).toBeNull();
				// Nothing more goes while it holds.
				expect(await c.ask('Again')).toBe(false);
				expect(send).toHaveBeenCalledTimes(1);
				expect(timers).toHaveLength(1);
				expect(Math.abs(timers[0]!.ms - 3_600_000)).toBeLessThan(5_000);
				timers[0]!.fn();
				expect(c.refusal).toBeNull();
				expect(c.capped).toBe(false);
			});
		}

		it('maps a reverse trial’s two caps as caps, not a plain error (342)', async () => {
			expect(DOLLAR_CAP_CODES).toContain('assistant_trial_cap');
			expect(DOLLAR_CAP_CODES).toContain('assistant_trial_daily_cap');
			const c = chatWith(async () => Promise.reject(new ApiError(429, 'That’s today’s assistant use on your trial.', undefined, 'assistant_trial_daily_cap', { seconds: 60, resetsAt: resetsIn(60) })), STATUS, () => {});
			await c.load();
			await c.ask('Q');
			expect(c.refusal).toMatchObject({ kind: 'cap', code: 'assistant_trial_daily_cap', message: 'That’s today’s assistant use on your trial.' });
		});

		it('takes params.seconds when resetsAt is missing or unreadable', async () => {
			const timers: { fn: () => void; ms: number }[] = [];
			const c = chatWith(async () => Promise.reject(new ApiError(429, 'Day', undefined, 'assistant_daily_cap', { seconds: 120, resetsAt: 'soon' })), STATUS, (fn, ms) => timers.push({ fn, ms }));
			await c.load();
			const before = Date.now();
			await c.ask('Q');
			expect(c.refusal).toMatchObject({ kind: 'cap', seconds: 120 });
			const at = Date.parse((c.refusal as Extract<Refusal, { kind: 'cap' }>).resetsAt);
			expect(at - before).toBeGreaterThanOrEqual(119_000);
			expect(at - before).toBeLessThan(125_000);
			expect(timers.map((t) => t.ms)).toEqual([120_000]);
		});

		it('a wait past setTimeout’s longest (a month’s cap early in the month) holds without a timer that would fire at once', async () => {
			const timers: { fn: () => void; ms: number }[] = [];
			const resetsAt = resetsIn(28 * 86_400);
			const c = chatWith(
				async () => Promise.reject(new ApiError(429, 'Month', undefined, 'assistant_monthly_cap', { seconds: 28 * 86_400, resetsAt })),
				STATUS,
				(fn, ms) => timers.push({ fn, ms })
			);
			await c.load();
			await c.ask('Q');
			expect(c.refusal).toMatchObject({ kind: 'cap', code: 'assistant_monthly_cap', resetsAt });
			expect(timers).toEqual([]);
			expect(c.capped).toBe(true);
		});

		it('keeps params.plan, and offers Compare plans on Free’s day and month only', async () => {
			const refusalFor = async (code: string, plan?: string) => {
				const c = chatWith(async () => Promise.reject(new ApiError(429, 'Words', undefined, code, { seconds: 60, resetsAt: resetsIn(60), ...(plan ? { plan } : {}) })), STATUS, () => {});
				await c.load();
				await c.ask('Q');
				return c.refusal;
			};
			const day = await refusalFor('assistant_daily_cap', 'free');
			expect(day).toMatchObject({ kind: 'cap', plan: 'free' });
			expect(capOffersPlans(day)).toBe(true);
			expect(capOffersPlans(await refusalFor('assistant_monthly_cap', 'free'))).toBe(true);
			// A paid account's month, a month whose plan the caller can't read, a member's share, the pool: none.
			expect(capOffersPlans(await refusalFor('assistant_monthly_cap', 'pro'))).toBe(false);
			expect(capOffersPlans(await refusalFor('assistant_monthly_cap'))).toBe(false);
			expect(capOffersPlans(await refusalFor('assistant_member_cap', 'team'))).toBe(false);
			expect(capOffersPlans(await refusalFor('assistant_free_pool_spent', 'free'))).toBe(false);
			// A reverse trial's caps are its own words, never an upsell (the trial is Pro already).
			expect(capOffersPlans(await refusalFor('assistant_trial_cap'))).toBe(false);
			expect(capOffersPlans(await refusalFor('assistant_trial_daily_cap'))).toBe(false);
			expect(capOffersPlans({ kind: 'rate', seconds: 60, message: 'x' })).toBe(false);
			expect(capOffersPlans(null)).toBe(false);
		});

		it('a newer refusal’s timer isn’t cleared by an older one', async () => {
			const timers: { fn: () => void; ms: number }[] = [];
			let n = 0;
			const c = chatWith(
				async () =>
					Promise.reject(
						n++ === 0
							? new ApiError(429, 'Too many', undefined, 'assistant_rate_limited', { seconds: 60 })
							: new ApiError(429, 'Pool', undefined, 'assistant_free_pool_spent', { seconds: 600, resetsAt: resetsIn(600) })
					),
				STATUS,
				(fn, ms) => timers.push({ fn, ms })
			);
			await c.load();
			await c.ask('Q');
			await c.ask('Q');
			expect(c.refusal).toMatchObject({ kind: 'cap', code: 'assistant_free_pool_spent' });
			timers[0]!.fn();
			expect(c.refusal).toMatchObject({ kind: 'cap' });
			timers[1]!.fn();
			expect(c.refusal).toBeNull();
		});
	});

	it('Stop aborts the fetch and keeps what had come', async () => {
		let signal: AbortSignal | null = null;
		const c = chatWith(async (_b, s) => {
			signal = s;
			return new ReadableStream<Uint8Array>({
				start(ctrl) {
					ctrl.enqueue(new TextEncoder().encode(sse([{ type: 'text', delta: 'Partial' }, { type: 'tool', name: 'get_series', label: 'Reading a series', status: 'start' }])));
					s.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
				}
			});
		});
		await c.load();
		const going = c.ask('Q');
		await vi.waitFor(() => expect((c.turns[1] as AssistantTurn | undefined)?.text).toBe('Partial'));
		expect(c.busy).toBe(true);
		c.stop();
		expect(await going).toBe(true);
		expect(signal!.aborted).toBe(true);
		const t = c.turns[1] as AssistantTurn;
		expect(t.stopped).toBe(true);
		expect(t.text).toBe('Partial');
		expect(t.error).toBeNull();
		// The tool it was running when stopped didn't finish.
		expect(t.tools[0]!.status).toBe('error');
		expect(c.busy).toBe(false);
	});

	it('words a wait', () => {
		expect(waitText(20)).toBe('20 s');
		expect(waitText(90)).toBe('2 min');
		expect(waitText(3600)).toBe('1 h');
		expect(waitText(5400)).toBe('1 h 30 min');
	});
});

// Past chats in this browser (history.ts): each turn is kept when it ends, under the person and project; a
// reopened chat continues with the existing send path; its changes are read-only; storage that fails turns
// history off and the conversation carries on.
describe('the day meter (a capped account, billing enforced)', () => {
	const FREE: AssistantDayMeter = {
		kind: 'free',
		usdMicrosPerDay: 300_000,
		usdMicrosLeft: 300_000,
		messagesLeft: 20,
		trialUsdMicrosLeft: null,
		medianTurnUsdMicros: 25_000,
		resetsAt: '2026-11-24T22:00:00.000Z'
	};
	const TRIAL: AssistantDayMeter = { ...FREE, kind: 'trial', usdMicrosPerDay: 1_000_000, usdMicrosLeft: 1_000_000, messagesLeft: null, trialUsdMicrosLeft: 2_000_000 };

	it('estimates questions left from the median question, worded as an estimate', () => {
		expect(dayMeterText({ ...FREE, usdMicrosLeft: 200_000 })).toBe('About 8 questions left today, at what your questions usually cost (an estimate).');
		expect(dayMeterText({ ...FREE, usdMicrosLeft: 30_000 })).toBe('About 1 question left today, at what your questions usually cost (an estimate).');
		expect(dayMeterText({ ...FREE, usdMicrosLeft: 10_000 })).toBe('Less than one question left today, at what your questions usually cost (an estimate).');
	});

	it('never says more than Free’s messages left, which is a count, not an estimate', () => {
		expect(dayMeterText({ ...FREE, messagesLeft: 3 })).toBe('Up to 3 questions left today.');
		expect(dayMeterText({ ...FREE, messagesLeft: 0 })).toBe('No questions left today.');
		expect(dayMeterText({ ...FREE, usdMicrosLeft: 0 })).toBe('No questions left today.');
	});

	it('with no median yet: Free’s message cap, a trial’s share of its day', () => {
		expect(dayMeterText({ ...FREE, medianTurnUsdMicros: null, messagesLeft: 17 })).toBe('Up to 17 questions left today.');
		expect(dayMeterText({ ...TRIAL, medianTurnUsdMicros: null, usdMicrosLeft: 400_000 })).toBe('40% of today’s trial assistant allowance left.');
	});

	it('a trial reads the less of its day and its whole allowance left', () => {
		expect(dayMeterText({ ...TRIAL, usdMicrosLeft: 1_000_000, trialUsdMicrosLeft: 100_000 })).toBe(
			'About 4 questions left today on your trial, at what your questions usually cost (an estimate).'
		);
		expect(dayMeterText({ ...TRIAL, trialUsdMicrosLeft: 0 })).toBe('No questions left today on your trial.');
	});

	it('is nothing without a day (billing off, a paid plan, an older server)', () => {
		expect(dayMeterText(null)).toBeNull();
		expect(dayMeterText(undefined)).toBeNull();
	});

	it('reads the status again after a turn, so the line counts down; a status that fails keeps the line', async () => {
		let left = 300_000;
		let fail = false;
		const status = vi.fn(async (): Promise<AssistantStatus> => {
			if (fail) throw new ApiError(500, 'down');
			return { ...STATUS, day: { ...FREE, usdMicrosLeft: left } };
		});
		const c = new AssistantChat({ status, send: async () => streamOf(sse([{ type: 'text', delta: 'Hi' }, { type: 'done' }])) });
		await c.load();
		expect(c.dayMeter).toBe('About 12 questions left today, at what your questions usually cost (an estimate).');
		left = 50_000;
		await c.ask('Q');
		await vi.waitFor(() => expect(c.dayMeter).toBe('About 2 questions left today, at what your questions usually cost (an estimate).'));
		fail = true;
		await c.ask('Q2');
		await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
		expect(c.dayMeter).toBe('About 2 questions left today, at what your questions usually cost (an estimate).');
	});

	it('doesn’t read the status again when there is no day to count down', async () => {
		const status = vi.fn(async () => structuredClone(STATUS));
		const c = new AssistantChat({ status, send: async () => streamOf(sse([{ type: 'done' }])) });
		await c.load();
		await c.ask('Q');
		expect(c.dayMeter).toBeNull();
		expect(status).toHaveBeenCalledTimes(1);
	});
});

describe('AssistantChat past chats', () => {
	function memory(): HistoryBackend & { rows: Map<string, ChatRecord> } {
		const rows = new Map<string, ChatRecord>();
		return {
			rows,
			all: async () => [...rows.values()].map((r) => structuredClone(r)),
			put: async (r) => void rows.set(r.key, structuredClone(r)),
			remove: async (keys) => keys.forEach((k) => rows.delete(k))
		};
	}
	const answerWith = (text: string, extra: AssistantStreamEvent[] = []) => async (_body: AssistantRequest, _signal: AbortSignal) => streamOf(sse([{ type: 'text', delta: text }, ...extra, { type: 'done' }]));
	let n = 0;
	function chatOn(be: HistoryBackend | null, send: (body: AssistantRequest, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>> = answerWith('An answer.'), userId = 'user-a', projectId = 'p1') {
		return new AssistantChat({
			status: async () => structuredClone(STATUS),
			send,
			history: async () => (be ? new ChatHistory(be, userId, projectId) : null),
			newId: () => `chat-${++n}`
		});
	}

	it('keeps each answered turn, and lists it for this person only', async () => {
		const be = memory();
		const a = chatOn(be);
		await a.load();
		await a.loadPast();
		expect(a.past).toEqual([]);
		expect(await a.ask('Why is the outlet flat?')).toBe(true);
		expect(a.id).not.toBeNull();
		expect(a.past?.map((p) => p.title)).toEqual(['Why is the outlet flat?']);

		// Positive control: A, on a fresh page, sees it; B on the same browser and project sees none.
		const again = chatOn(be);
		await again.loadPast();
		expect(again.past?.map((p) => p.title)).toEqual(['Why is the outlet flat?']);
		const b = chatOn(be, undefined, 'user-b');
		await b.loadPast();
		expect(b.past).toEqual([]);
	});

	it('reopens a past chat and continues it: the next turn sends the transcript and updates the same chat', async () => {
		const be = memory();
		const first = chatOn(be);
		await first.load();
		await first.ask('First question');
		const id = first.id!;

		const send = vi.fn(answerWith('A second answer.'));
		const page = chatOn(be, send);
		await page.load();
		await page.loadPast();
		expect(await page.reopen(id)).toBe(true);
		expect(page.id).toBe(id);
		expect(page.turns.map((t) => t.text)).toEqual(['First question', 'An answer.']);
		await page.ask('A follow-up');
		expect(send.mock.calls[0]![0].messages).toEqual([
			{ role: 'user', content: 'First question' },
			{ role: 'assistant', content: 'An answer.' },
			{ role: 'user', content: 'A follow-up' }
		]);
		expect(page.past).toHaveLength(1);
		expect(be.rows.get(`user-a/p1/${id}`)!.turns.map((t) => t.text)).toEqual(['First question', 'An answer.', 'A follow-up', 'A second answer.']);
	});

	it('a reopened chat’s recommended change is read-only: nothing to apply', async () => {
		const be = memory();
		const first = chatOn(be, answerWith('One change.', [{ type: 'proposal', proposal: PROPOSAL }]));
		await first.load();
		await first.ask('Recommend something');
		const live = (first.turns[1] as AssistantTurn).proposals[0]!;
		// Positive control: in the conversation it came in, the change applies.
		expect(applicable(live)).toEqual(PROPOSAL);

		const later = chatOn(be);
		await later.reopen(first.id!);
		const old = (later.turns[1] as AssistantTurn).proposals[0]!;
		expect(old.stale).toBe(true);
		expect(old.proposal.apply).toBeUndefined();
		expect(applicable(old)).toBeNull();
		expect(old.proposal.title).toBe(PROPOSAL.title);
	});

	it('deleting the open chat starts a new conversation; Clear history empties the list', async () => {
		const be = memory();
		const c = chatOn(be);
		await c.load();
		await c.ask('One');
		const one = c.id!;
		c.clear();
		await c.ask('Two');
		expect(c.past?.map((p) => p.title)).toEqual(['Two', 'One']);
		await c.remove(c.id!);
		expect(c.turns).toEqual([]);
		expect(c.id).toBeNull();
		expect(c.past?.map((p) => p.id)).toEqual([one]);
		await c.clearHistory();
		expect(c.past).toEqual([]);
		expect(be.rows.size).toBe(0);
	});

	it('with no storage, history is off and the conversation still works', async () => {
		const none = chatOn(null);
		await none.load();
		await none.loadPast();
		expect(none.historyOff).toBe(true);
		expect(none.past).toBeNull();
		expect(await none.ask('Still there?')).toBe(true);
		expect((none.turns[1] as AssistantTurn).text).toBe('An answer.');
	});

	it('storage that throws turns history off; the answer still shows', async () => {
		const broken: HistoryBackend = {
			all: () => Promise.reject(new DOMException('blocked', 'SecurityError')),
			put: () => Promise.reject(new Error('full')),
			remove: () => Promise.reject(new Error('blocked'))
		};
		const c = chatOn(broken);
		await c.load();
		await c.loadPast();
		expect(c.historyOff).toBe(true);
		expect(await c.ask('Does it answer?')).toBe(true);
		expect((c.turns[1] as AssistantTurn).text).toBe('An answer.');
		expect(await c.reopen('anything')).toBe(false);

		// A loader that throws (IndexedDB missing in a sandboxed frame) is the same.
		const thrower = new AssistantChat({ status: async () => structuredClone(STATUS), send: answerWith('Fine.'), history: () => Promise.reject(new Error('no idb')) });
		await thrower.load();
		await thrower.loadPast();
		expect(thrower.historyOff).toBe(true);
		expect(await thrower.ask('Hello')).toBe(true);
	});

	it('sends at most the server’s message count, starting at a question', () => {
		const many = Array.from({ length: MAX_SENT_MESSAGES + 5 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), content: `m${i}` }));
		many.push({ role: 'user', content: 'last' });
		const sent = capMessages(many);
		expect(sent.length).toBeLessThanOrEqual(MAX_SENT_MESSAGES);
		expect(sent[0]!.role).toBe('user');
		expect(sent.at(-1)!.content).toBe('last');
		const few = [{ role: 'user' as const, content: 'q' }];
		expect(capMessages(few)).toBe(few);
	});
});
