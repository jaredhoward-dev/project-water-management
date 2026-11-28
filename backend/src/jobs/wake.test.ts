import { afterEach, describe, expect, it, vi } from 'vitest';

// The sqs transport's sender and the memory transport's tick, observed (no AWS, no database).
const sent: { url: string; body: string }[] = [];
vi.mock('./transport.js', async (orig) => ({
	...(await orig<typeof import('./transport.js')>()),
	sqs: async (url: string) => async (body: string) => {
		sent.push({ url, body });
	}
}));
const runTick = vi.fn(async () => ({}));
vi.mock('./runner.js', () => ({ runTick: () => runTick() }));

const { jobTransport, wakeWorker } = await import('./wake.js');
const { parseWorkerMessage } = await import('./transport.js');

afterEach(() => {
	vi.unstubAllEnvs();
	sent.length = 0;
	runTick.mockClear();
});

describe('jobTransport', () => {
	it('defaults to inprocess (local-first)', () => {
		expect(jobTransport(undefined)).toBe('inprocess');
		expect(jobTransport('')).toBe('inprocess');
		expect(jobTransport('  ')).toBe('inprocess');
	});

	it('accepts the three transports and refuses anything else', () => {
		for (const t of ['inprocess', 'memory', 'sqs'] as const) expect(jobTransport(t)).toBe(t);
		expect(() => jobTransport('localstack')).toThrow(/unknown JOB_TRANSPORT "localstack"/);
	});
});

describe('wakeWorker', () => {
	it('never throws: a failed wake-up is logged (the tick runs the job later)', async () => {
		vi.stubEnv('JOB_TRANSPORT', 'sqs');
		vi.stubEnv('JOBS_QUEUE_URL', '');
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(wakeWorker('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('waking the job worker failed'), 'JOBS_QUEUE_URL is not set');
		spy.mockRestore();
	});

	it('does nothing for inprocess (the insert trigger NOTIFYs the worker)', async () => {
		vi.stubEnv('JOB_TRANSPORT', 'inprocess');
		const spy = vi.spyOn(console, 'error');
		await wakeWorker('00000000-0000-4000-8000-000000000000');
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('sqs: sends one wake message naming the job to JOBS_QUEUE_URL, which the worker understands', async () => {
		vi.stubEnv('JOB_TRANSPORT', 'sqs');
		vi.stubEnv('JOBS_QUEUE_URL', 'https://sqs.example/jobs');
		const id = '11111111-1111-4111-8111-111111111111';
		await wakeWorker(id);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe('https://sqs.example/jobs');
		expect(parseWorkerMessage(sent[0]!.body)).toEqual({ v: 1, type: 'wake', jobId: id });
		expect(runTick).not.toHaveBeenCalled();
	});

	it('memory: runs one tick inline before returning, and sends nothing', async () => {
		vi.stubEnv('JOB_TRANSPORT', 'memory');
		await wakeWorker('00000000-0000-4000-8000-000000000000');
		expect(runTick).toHaveBeenCalledOnce();
		expect(sent).toEqual([]);
	});

	it('never throws on a tick that fails or an unknown JOB_TRANSPORT: logged, the job stays queued for the next tick', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubEnv('JOB_TRANSPORT', 'memory');
		runTick.mockRejectedValueOnce(new Error('tick broke'));
		await expect(wakeWorker('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
		expect(spy).toHaveBeenLastCalledWith(expect.stringContaining('waking the job worker failed'), 'tick broke');
		vi.stubEnv('JOB_TRANSPORT', 'kafka');
		await expect(wakeWorker('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
		expect(spy).toHaveBeenLastCalledWith(expect.stringContaining('waking the job worker failed'), expect.stringContaining('unknown JOB_TRANSPORT "kafka"'));
		expect(sent).toEqual([]);
		spy.mockRestore();
	});
});
