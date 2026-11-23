// The operator's staff grant of a plan (330_staff_grant, issue #641 "Staff
// overrides"; docs/billing.md § Staff grants), locally:
//
//   pnpm dev:billing:grant <email|team-id> <plan> [--until YYYY-MM-DD] --reason "…" [--replace] [--by <name>]
//   pnpm dev:billing:grant <email|team-id> --revoke --reason "…" [--by <name>]
//   pnpm dev:billing:grant <email|team-id> --list
//
// Runs app_staff_grant_plan / app_staff_revoke_grant as the schema owner
// (MIGRATION_DATABASE_URL) on this checkout's dev database; in production the
// operator runs the same functions as the schema owner. A grant lasts through
// its --until date in South African time (it ends at the next SAST midnight),
// whatever this machine's time zone; without --until it lasts until revoked.
// An address is used only to find the person's account and is never printed
// beyond what the operator typed.
import os from 'node:os';
import pg from 'pg';
import { loadDevEnv } from '../src/config/devEnv.js';

export type GrantArgs =
	| { mode: 'grant'; target: Target; plan: string; until: string | null; reason: string; by: string; replace: boolean }
	| { mode: 'revoke'; target: Target; reason: string; by: string }
	| { mode: 'list'; target: Target };
export type Target = { kind: 'user'; email: string } | { kind: 'team'; teamId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const VALUE_FLAGS = new Set(['--until', '--reason', '--by']);
const BARE_FLAGS = new Set(['--revoke', '--list', '--replace']);
export const USAGE = [
	'usage: pnpm dev:billing:grant <email|team-id> <plan> [--until YYYY-MM-DD] --reason "…" [--replace] [--by <name>]',
	'       pnpm dev:billing:grant <email|team-id> --revoke --reason "…" [--by <name>]',
	'       pnpm dev:billing:grant <email|team-id> --list'
].join('\n');

/** A calendar date that exists (2026-02-30 doesn't). */
export function isCalendarDate(s: string): boolean {
	const m = DATE.exec(s);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** The arguments, or why they can't be taken. `defaultBy` is who acts when --by isn't given (the operator's login). */
export function parseArgs(argv: string[], defaultBy: string): GrantArgs | string {
	const flags = new Map<string, string>();
	const bare = new Set<string>();
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (VALUE_FLAGS.has(a)) {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
			flags.set(a, v);
			i++;
		} else if (BARE_FLAGS.has(a)) bare.add(a);
		else if (a.startsWith('--')) return `unknown option ${a}`;
		else positional.push(a);
	}
	const [who, plan, extra] = positional;
	if (!who) return 'give the person’s email address or the team’s id';
	let target: Target;
	if (UUID.test(who)) target = { kind: 'team', teamId: who.toLowerCase() };
	else if (who.includes('@')) target = { kind: 'user', email: who.trim().toLowerCase() };
	else return 'give the person’s email address or the team’s id (a uuid)';
	if (bare.has('--revoke') && bare.has('--list')) return 'give one of --revoke and --list';
	const reason = (flags.get('--reason') ?? '').trim();
	const by = (flags.get('--by') ?? defaultBy).trim();
	if (reason.length > 500) return 'keep --reason to 500 characters';
	if (!by || by.length > 100) return 'give who acts with --by (at most 100 characters)';

	if (bare.has('--list')) {
		if (plan || flags.size || bare.size > 1) return '--list takes only the person or team';
		return { mode: 'list', target };
	}
	if (bare.has('--revoke')) {
		if (plan) return `unexpected argument ${plan}: --revoke ends the account’s grant, whatever its plan`;
		if (flags.has('--until') || bare.has('--replace')) return '--revoke takes no --until or --replace';
		if (!reason) return 'give the reason with --reason (it goes into the grant log, which the account can read)';
		return { mode: 'revoke', target, reason, by };
	}
	if (!plan) return 'give the plan to grant (pro or team)';
	if (extra) return `unexpected argument ${extra}`;
	const until = flags.get('--until') ?? null;
	if (until !== null && !isCalendarDate(until)) return '--until is a date, YYYY-MM-DD (the grant lasts through that day, SAST)';
	if (!reason) return 'give the reason with --reason (it goes into the grant log, which the account can read)';
	return { mode: 'grant', target, plan: plan.toLowerCase(), until, reason, by, replace: bare.has('--replace') };
}

/** The end of a YYYY-MM-DD in SAST, as SQL: the next SAST midnight, whatever the session's time zone. */
export const UNTIL_SQL = `(($1::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')`;

/** The target's billing account id: made if missing for a grant (billing_account_ensure, 323), else NULL when it has none. */
async function accountOf(client: pg.ClientBase, target: Target, ensure: boolean): Promise<string | null> {
	let owner: string;
	if (target.kind === 'user') {
		const { rows } = await client.query<{ id: string }>('SELECT id FROM app_user WHERE lower(email::text) = $1', [target.email]);
		if (!rows[0]) throw new Error(`no account with the address ${target.email}`);
		owner = rows[0].id;
	} else {
		const { rows } = await client.query<{ id: string }>('SELECT id FROM team WHERE id = $1', [target.teamId]);
		if (!rows[0]) throw new Error(`no team ${target.teamId}`);
		owner = rows[0].id;
	}
	const { rows } = ensure
		? await client.query<{ id: string }>('SELECT billing_account_ensure($1, $2) AS id', [target.kind, owner])
		: await client.query<{ id: string }>(`SELECT id FROM billing_account WHERE ${target.kind === 'user' ? 'user_id' : 'team_id'} = $1`, [owner]);
	return rows[0]?.id ?? null;
}

export interface LogRow {
	at: string;
	action: string;
	plan: string;
	until: string | null;
	by: string;
	reason: string;
}

/** Run one command on the schema owner's connection `url`; returns the lines to print. */
export async function runGrant(url: string, args: GrantArgs): Promise<string[]> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	const who = args.target.kind === 'user' ? args.target.email : `team ${args.target.teamId}`;
	try {
		if (args.mode === 'list') {
			const account = await accountOf(client, args.target, false);
			if (!account) return [`${who} has no billing account (Free, never granted).`];
			const { rows } = await client.query<LogRow>(
				`SELECT to_char(created_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS at, action, plan_code AS plan,
					to_char(until AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS until, granted_by AS by, reason
				 FROM billing_grant_log WHERE billing_account_id = $1 ORDER BY created_at, id`,
				[account]
			);
			const { rows: plan } = await client.query<{ code: string }>('SELECT billing_account_plan_code($1) AS code', [account]);
			return [
				`${who}: on ${plan[0]?.code ?? 'free'} now.`,
				...(rows.length ? rows.map((r) => `${r.at} SAST  ${r.action.padEnd(6)} ${r.plan.padEnd(5)} ends ${r.until ? `${r.until} SAST` : 'when revoked'}  by ${r.by}: ${r.reason}`) : ['No grants logged.'])
			];
		}
		await client.query('BEGIN');
		const account = await accountOf(client, args.target, args.mode === 'grant');
		if (args.mode === 'revoke') {
			if (!account) throw new Error(`${who} has no billing account, so no grant`);
			// Two statements: a statement doesn't see the rows a function it calls changed.
			const { rows: ended } = await client.query<{ id: string }>('SELECT app_staff_revoke_grant($1, $2, $3) AS id', [account, args.reason, args.by]);
			const { rows } = await client.query<{ plan: string }>('SELECT plan_code AS plan FROM subscription WHERE id = $1', [ended[0]!.id]);
			await client.query('COMMIT');
			return [`Revoked ${who}’s ${rows[0]?.plan ?? ''} grant; the account is on Free now. Logged: ${args.reason}`];
		}
		const { rows: granted } = await client.query<{ id: string }>(
			`SELECT app_staff_grant_plan($2, $3, CASE WHEN $1::text IS NULL THEN NULL ELSE ${UNTIL_SQL} END, $4, $5, $6) AS id`,
			[args.until, account, args.plan, args.reason, args.by, args.replace]
		);
		const { rows } = await client.query<{ until: string | null }>(
			`SELECT to_char(period_end AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS until FROM subscription WHERE id = $1`,
			[granted[0]!.id]
		);
		await client.query('COMMIT');
		const until = rows[0]?.until ? `through ${args.until} (it ends ${rows[0].until} SAST)` : 'until revoked';
		return [`Granted ${args.plan} to ${who} ${until}${args.replace ? ', replacing its live subscription' : ''}. Logged: ${args.reason}`];
	} catch (err) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw err;
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2), os.userInfo().username);
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	runGrant(url, args)
		.then((lines) => {
			for (const l of lines) console.log(l);
			process.exit(0);
		})
		.catch((err: Error) => {
			// The database's own words for its refusals (a live Stripe subscription, no grant): the operator's terminal only.
			console.error(err.message);
			process.exit(1);
		});
}
