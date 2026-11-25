// What a Free person's assistant begin costs with many accounts in the Free pool
// (361_assistant_month_counter; docs/billing.md § The counters). Before 361 the
// begin summed every pool account's month and day rows (assistant_dollars_spent)
// under the deployment-wide lock, so its cost grew with the accounts; now it reads
// counters and the reservations in flight. Seeds ACCOUNTS Free accounts with a
// month's and a day's spend, then times begins.
//
// Its own vitest project (`perf-db`, vitest.config.ts): a timing claim, so out of
// `pnpm test` and CI. Run it alone: `pnpm test:backend:perf:db`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

const ACCOUNTS = 3_000;
const SAMPLES = 15;
// A begin's budget with ACCOUNTS pool accounts, median of SAMPLES (a few ms on a laptop; 336's sum took tens).
const BUDGET_MS = 25;
const TAG = 'perf-begin-361';

let user: Awaited<ReturnType<typeof signUp>>;
let projectId: string;

const begin = () =>
	withUser(user.id, async (db) => {
		const { rows } = await db.query(
			`SELECT outcome FROM app_assistant_begin($1, 1000000000, 100000, 1000000000, 10000000000000, 150000, 1000, 300, 2.5, 1000000000, 100000, 1000000000000000)`,
			[projectId]
		);
		return rows[0].outcome as string;
	});

const cleanup = async () => {
	await asOwner(`DELETE FROM project WHERE name = $1`, [TAG]);
	await asOwner(`DELETE FROM app_user WHERE email LIKE $1`, [`${TAG}-%@example.com`]);
};

beforeAll(async () => {
	await cleanup();
	user = await signUp('Beginperf');
	projectId = (await user.call('POST', '/projects', { name: 'Begin perf catchment' })).body.project.id;
	// ACCOUNTS Free accounts, each with a project, this month's recorded cost and today's day row.
	await asOwner(
		`WITH u AS (
			INSERT INTO app_user (email, display_name, password_hash)
			SELECT $1 || '-' || g || '@example.com', 'Perf ' || g, 'x' FROM generate_series(1, $2::int) g
			RETURNING id
		), a AS (
			INSERT INTO billing_account (kind, user_id) SELECT 'user', id FROM u
			ON CONFLICT (user_id) DO UPDATE SET kind = EXCLUDED.kind
			RETURNING id, user_id
		)
		INSERT INTO project (name, created_by, billing_account_id) SELECT $1, user_id, id FROM a`,
		[TAG, ACCOUNTS]
	);
	await asOwner(
		`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros)
		 SELECT p.id, p.created_by, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1000 FROM project p WHERE p.name = $1`,
		[TAG]
	);
	await asOwner(
		`INSERT INTO assistant_day_usage (billing_account_id, user_id, day, messages, cost_usd_micros)
		 SELECT p.billing_account_id, p.created_by, assistant_day_of(now()), 1, 500 FROM project p WHERE p.name = $1`,
		[TAG]
	);
}, 300_000);

afterAll(async () => {
	await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
	await cleanup();
}, 300_000);

describe('assistant begin cost', () => {
	it(`with ${ACCOUNTS} Free pool accounts stays under ${BUDGET_MS} ms (median of ${SAMPLES})`, async () => {
		// Positive control: the seeded accounts are in the pool sum the begin reads.
		const [pool] = await asOwner(
			`SELECT pool_month::float8 AS m FROM assistant_dollars_spent(date_trunc('month', now() AT TIME ZONE 'UTC')::date, assistant_day_of(now()), NULL, NULL)`
		);
		expect(pool!.m).toBeGreaterThanOrEqual(ACCOUNTS * 1000);
		expect(await begin()).toBe('ok');
		const ms: number[] = [];
		for (let i = 0; i < SAMPLES; i++) {
			const t = performance.now();
			expect(await begin()).toBe('ok');
			ms.push(performance.now() - t);
		}
		ms.sort((a, b) => a - b);
		const median = ms[SAMPLES >> 1]!;
		console.info(`assistant begin with ${ACCOUNTS} pool accounts: median ${median.toFixed(1)} ms`);
		expect(median).toBeLessThan(BUDGET_MS);
	}, 120_000);
});
