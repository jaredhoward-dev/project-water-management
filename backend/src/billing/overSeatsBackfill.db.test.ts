// 416_over_seats_backfill (round 2026-11-28; docs/billing.md § Team seats): a team already over its paid seats from
// before 403/404 wrote markers gets over_seats_since set; running it again changes nothing; a team within its seats
// stays unmarked (positive control for the recount), and a team already marked keeps its first since.
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

const BACKFILL = readFileSync(new URL('../../migrations/416_over_seats_backfill.sql', import.meta.url), 'utf8');
const accounts: string[] = [];
const since = async (account: string) =>
	((await asOwner('SELECT over_seats_since AS t FROM billing_account WHERE id = $1', [account])) as { t: Date | null }[])[0]!.t;

/** A team on 3 paid Team seats with `editors` editors (the admin among them), its marker cleared as data from before 403/404. */
async function team(name: string, editors: number): Promise<string> {
	const admin = await signUp(`${name}Admin`);
	const teamId = (await admin.call('POST', '/teams', { name: `${name} ${crypto.randomUUID().slice(0, 8)}` })).body.team.id as string;
	const account = ((await asOwner(`SELECT billing_account_ensure('team', $1) AS id`, [teamId])) as { id: string }[])[0]!.id;
	await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'team', 'active', 3, 'mock')`, [account]);
	for (let i = 1; i < editors; i++) {
		const m = await signUp(`${name}M${i}`);
		await asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, m.id]);
	}
	await asOwner('UPDATE billing_account SET over_seats_since = NULL WHERE id = $1', [account]);
	accounts.push(account);
	return account;
}

afterAll(() => asOwner(`DELETE FROM subscription WHERE billing_account_id = ANY($1::uuid[])`, [accounts]));

describe('416: the over-seats backfill', () => {
	it('marks a team over its seats, leaves one within them, keeps an existing since, and is idempotent', async () => {
		const over = await team('BackfillOver', 4);
		const within = await team('BackfillWithin', 3);
		const marked = await team('BackfillMarked', 5);
		const first = new Date('2026-10-01T00:00:00Z');
		await asOwner('UPDATE billing_account SET over_seats_since = $2 WHERE id = $1', [marked, first]);

		await asOwner(BACKFILL);
		const set = await since(over);
		expect(set).toBeInstanceOf(Date);
		expect(await since(within)).toBeNull();
		expect((await since(marked))!.toISOString()).toBe(first.toISOString());

		await asOwner(BACKFILL);
		expect((await since(over))!.toISOString()).toBe(set!.toISOString());
		expect(await since(within)).toBeNull();
		expect((await since(marked))!.toISOString()).toBe(first.toISOString());
	});
});
