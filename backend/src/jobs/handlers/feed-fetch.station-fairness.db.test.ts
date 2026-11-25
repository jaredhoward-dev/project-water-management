// Per-project fairness on the station queue (issue #784 follow-up, 363_station_feed_fairness): a production-shaped
// worker (FEED_FETCHER=sqs) sends a project's station fetches only while it has fewer than
// STATION_FETCHES_PER_PROJECT out. A project with many station feeds on slow hosts (their answers not back yet) gets
// that many onto the station queue and the rest go back to the job table, their attempt given back; another
// project's one feed is still sent in the same tick. Positive controls: once the first answers are applied, the same
// project's waiting fetches go out, so a project alone still drains its own queue; and an answer lost for a day no
// longer holds a place (app_feed_fetch_out).
//
// DB test files run one at a time; afterEach removes every feed and feed job.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as { feedId: string; group?: string }[] }));
vi.mock('../transport.js', async (orig) => ({
	...(await orig<typeof import('../transport.js')>()),
	sendToQueue: async (url: string | undefined, name: string, message: { feedId: string }, fifo?: { group: string }) => {
		if (!url) throw new Error(`${name} is not set`);
		sent.push({ feedId: message.feedId, group: fifo?.group });
	}
}));
import { asOwner, signUp } from '../../__tests__/helpers.js';
import { STATION_FIXTURE_KEY } from '../../feeds/stationFixtures.js';
import { runTick } from '../runner.js';
import { STATION_FETCHES_PER_PROJECT, STATION_TURN_WAIT_SECONDS } from './feed-fetch.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });

function sqsWorker() {
	vi.stubEnv('FEED_FETCHER', 'sqs');
	vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests.fifo');
	vi.stubEnv('STATION_FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/station-fetch-requests.fifo');
}

/** A project with `n` station API feeds, each pressed Run now (its feed_fetch job queued). */
async function stationProject(owner: User, name: string, n: number): Promise<{ pid: string; fids: string[] }> {
	const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const fids: string[] = [];
	for (let i = 0; i < n; i++) {
		const r = await owner.call('POST', `/projects/${pid}/feeds`, {
			source: 'station_api',
			config: {
				url: 'https://station.example/v1/keyed/daily.json?station={station}&start={start}&end={end}',
				station: `ST-00${i + 1}`,
				auth: { kind: 'bearer' },
				format: { format: 'json', records: 'data', time: 'date', value: 'rain_mm', timeFormat: 'YYYY-MM-DD', resolution: 'daily' }
			},
			credential: { secret: STATION_FIXTURE_KEY },
			// One series each, named in sort order (a second feed on one series is refused, and so is one taking over the first).
			targetName: `Station ${i + 1}`
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const fid = r.body.feed.id as string;
		expect((await owner.call('POST', `/projects/${pid}/feeds/${fid}/run-now`)).status).toBe(202);
		fids.push(fid);
	}
	return { pid, fids };
}

const sentOf = (fids: string[]) => sent.filter((s) => fids.includes(s.feedId));

/** The fetcher's answers to these feeds' fetches are applied: their record of a fetch out is cleared (as app_take_feed_fetch does). */
async function answer(fids: string[]) {
	await asOwner(`UPDATE data_feed SET fetch_job_id = NULL, fetch_start = NULL, fetch_end = NULL WHERE id = ANY ($1::uuid[])`, [fids]);
}

/** The released jobs' wait is over. */
const waitOver = () => asOwner(`UPDATE job SET run_after = now() WHERE kind = 'feed_fetch' AND status = 'queued'`);

describe('a project has at most STATION_FETCHES_PER_PROJECT station fetches out', () => {
	it('a project with many slow station feeds can’t hold another project’s feed back', async () => {
		sqsWorker();
		const slow = await stationProject(await signUp('FairSlow'), 'Slow hosts', 5);
		const other = await stationProject(await signUp('FairOther'), 'One feed', 1);

		const result = await tick();
		// The slow project: its share went out, the rest went back to wait, their attempt given back.
		expect(sentOf(slow.fids)).toHaveLength(STATION_FETCHES_PER_PROJECT);
		expect(result.released).toBe(5 - STATION_FETCHES_PER_PROJECT);
		// The other project's feed went out in the same tick, behind none of the slow project's waiting fetches.
		expect(sentOf(other.fids)).toEqual([{ feedId: other.fids[0], group: 'station:station.example' }]);
		const waiting = (await asOwner(
			`SELECT payload->>'feedId' AS fid, attempts, extract(epoch FROM run_after - now())::float8 AS wait FROM job WHERE kind = 'feed_fetch' AND status = 'queued'`
		)) as { fid: string; attempts: number; wait: number }[];
		expect(waiting).toHaveLength(5 - STATION_FETCHES_PER_PROJECT);
		for (const w of waiting) {
			expect(slow.fids).toContain(w.fid);
			expect(w.attempts).toBe(0);
			expect(w.wait).toBeGreaterThan(0);
			expect(w.wait).toBeLessThanOrEqual(STATION_TURN_WAIT_SECONDS);
		}
		// Nothing was recorded for a fetch that wasn't sent.
		const out = (await asOwner(`SELECT count(*)::int AS n FROM data_feed WHERE fetch_job_id IS NOT NULL AND id = ANY ($1::uuid[])`, [slow.fids])) as { n: number }[];
		expect(out[0]!.n).toBe(STATION_FETCHES_PER_PROJECT);
	});

	it('a project alone still drains its own station queue as its answers come back (positive control)', async () => {
		sqsWorker();
		const { fids } = await stationProject(await signUp('FairDrain'), 'Drains', 5);
		const done = new Set<string>();
		for (let round = 0; round < 3 && done.size < fids.length; round++) {
			sent.length = 0;
			await tick();
			// Never more than its share out at once.
			expect(sent.length).toBeGreaterThan(0);
			expect(sent.length).toBeLessThanOrEqual(STATION_FETCHES_PER_PROJECT);
			for (const s of sent) done.add(s.feedId);
			await answer(sent.map((s) => s.feedId));
			await waitOver();
		}
		expect([...done].sort()).toEqual([...fids].sort());
		expect(await asOwner(`SELECT id FROM job WHERE kind = 'feed_fetch' AND status IN ('queued', 'failed', 'dead')`)).toEqual([]);
	});

	it('an answer lost for a day no longer holds its project’s place', async () => {
		sqsWorker();
		const { fids } = await stationProject(await signUp('FairLost'), 'Lost answers', STATION_FETCHES_PER_PROJECT + 1);
		await tick();
		expect(sent).toHaveLength(STATION_FETCHES_PER_PROJECT);
		sent.length = 0;
		// The sent fetches' answers never come; a day passes since their jobs last started.
		await asOwner(
			`UPDATE job SET started_at = now() - interval '25 hours', created_at = now() - interval '25 hours' WHERE kind = 'feed_fetch' AND status = 'done'`
		);
		await waitOver();
		await tick();
		expect(sent).toHaveLength(1);
		expect(fids).toContain(sent[0]!.feedId);
	});
});
