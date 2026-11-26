// Cost of the mode re-check app_alert_claim makes on every claim (370, issue
// #868; 386, issue #890) with a large digest backlog: 20 people who chose
// daily, 500 alerts each waiting for the morning digest (10 000 lines).
//
// 370 read the audience (alert_audience) of every event with a waiting
// delivery on each claim, so each tick paid for the whole backlog. 386 reads
// it only for deliveries whose recipient's own subscription row could have
// moved them (a 'daily_digest' row for a pending one, an 'immediate' row or
// none for a digest line); for people who still choose daily that is index
// lookups. The guard times the claim, and 370's audience read of the same
// backlog on the same connection for comparison, and checks a person who
// switches back to right away is still moved (the positive control: the
// shortcut must not hide a real change).
//
// Its own vitest project (`perf-db`, vitest.config.ts): a timing claim, so
// out of `pnpm test` and CI. Run it alone: `pnpm test:backend:perf:db`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser } from '../db/tx.js';

const PEOPLE = 20;
const LINES = 500;
const SAMPLES = 5;

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let people: User[];
let projectId: string;

/** One claim as the worker makes it (alerts/send.ts), its wall time. */
async function timedClaim(): Promise<number> {
	const t = performance.now();
	await withoutUser((db) => db.query(`SELECT * FROM app_alert_claim(100, now(), 5, interval '10 minutes')`));
	return performance.now() - t;
}

/** 370's re-check, read only: the audience of every event with a waiting delivery. */
async function timed370(): Promise<number> {
	const t = performance.now();
	await asOwner(
		`WITH keys AS (
			SELECT DISTINCT e.id, e.project_id, e.kind, e.node_id
			FROM alert_delivery a JOIN alert_event e ON e.id = a.event_id
			WHERE a.status IN ('pending', 'digest')
		)
		SELECT count(*) FROM alert_delivery a
		JOIN keys k ON k.id = a.event_id
		CROSS JOIN LATERAL alert_audience(k.project_id, k.kind, k.node_id) au
		WHERE au.user_id = a.user_id
		  AND ((a.status = 'pending' AND au.mode = 'daily_digest')
		    OR (a.status = 'digest' AND au.mode = 'immediate' AND a.reason IS DISTINCT FROM 'over the daily cap'))`
	);
	return performance.now() - t;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

beforeAll(async () => {
	owner = await signUp('Claimperf');
	projectId = (await owner.call('POST', '/projects', { name: 'Claim perf catchment' })).body.project.id;
	people = await Promise.all(Array.from({ length: PEOPLE }, (_, i) => signUp(`Claimperf${i}`)));
	for (const u of people) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role: 'editor' })).status).toBe(201);
		expect((await u.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'data_stale', mode: 'daily_digest' }] })).status).toBe(200);
	}
	const [rule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'data_stale', 3) RETURNING id`, [projectId]);
	await asOwner(
		`WITH e AS (
			INSERT INTO alert_event (rule_id, project_id, state, value, detail)
			SELECT $1, $2, 'cleared', 4, jsonb_build_object('i', i) FROM generate_series(1, $4::int) i
			RETURNING id
		)
		INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, created_at)
		SELECT e.id, u, $2, 'daily_digest', 'digest', now() - interval '1 hour' FROM e CROSS JOIN unnest($3::uuid[]) u`,
		[rule.id, projectId, people.map((u) => u.id), LINES]
	);
	await asOwner('ANALYZE alert_delivery');
	await asOwner('ANALYZE alert_subscription');
}, 120_000);

afterAll(async () => {
	await asOwner('DELETE FROM alert_delivery WHERE project_id = $1', [projectId]);
	await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [projectId]);
});

describe('the mode re-check with a large digest backlog (386, issue #890)', () => {
	it(`claims under 150 ms, median of ${SAMPLES}, with ${PEOPLE * LINES} daily lines waiting, and costs less than 370’s audience read of them`, async () => {
		await timedClaim(); // warm the plan cache
		const xs: number[] = [];
		for (let i = 0; i < SAMPLES; i++) xs.push(await timedClaim());
		const claim = median(xs);
		const xs370: number[] = [];
		for (let i = 0; i < SAMPLES; i++) xs370.push(await timed370());
		const before = median(xs370);
		console.info(`app_alert_claim, ${PEOPLE * LINES} daily lines waiting: ${claim.toFixed(1)} ms; 370's audience read of them: ${before.toFixed(1)} ms`);
		// Nothing moved: everyone still chooses daily.
		const [{ n }] = await asOwner(`SELECT count(*)::int AS n FROM alert_delivery WHERE project_id = $1 AND status = 'digest'`, [projectId]);
		expect(n).toBe(PEOPLE * LINES);
		expect(claim).toBeLessThan(150);
		expect(claim).toBeLessThan(before);
	});

	it('still moves the lines of a person who switched back to right away (positive control)', async () => {
		const u = people[0]!;
		expect((await u.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'data_stale', mode: 'immediate' }] })).status).toBe(200);
		await timedClaim();
		const rows = await asOwner(
			`SELECT user_id = $2 AS switched, count(*)::int AS n FROM alert_delivery WHERE project_id = $1 AND status = 'digest' AND reason IS NULL GROUP BY 1 ORDER BY 1`,
			[projectId, u.id]
		);
		// Every one of u's lines left the daily queue (claimed, or back in the digest only by the cap); nobody else's did.
		expect(rows).toEqual([{ switched: false, n: (PEOPLE - 1) * LINES }]);
	});
});
