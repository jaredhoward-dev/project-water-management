// The operator's staff grant of a plan (330_staff_grant, issue #641 "Staff
// overrides"; docs/billing.md § Staff grants), locally:
//
//   pnpm dev:billing:grant <email|team-id> <plan> [--until YYYY-MM-DD] [--seats n] --reason "…" [--replace] [--by <name>]
//   pnpm dev:billing:grant <email|team-id> --revoke --reason "…" [--by <name>]
//   pnpm dev:billing:grant <email|team-id> --list
//
// Runs app_staff_grant_plan / app_staff_revoke_grant as the schema owner
// (MIGRATION_DATABASE_URL) on this checkout's dev database; in production the
// operator runs the same functions as the schema owner. A grant lasts through
// its --until date in South African time (it ends at the next SAST midnight),
// whatever this machine's time zone; without --until it lasts until revoked.
// An address is used only to find the person's account and is never printed
// beyond what the operator typed. The logic is src/billing/staffGrant.ts,
// shared with the migrate Lambda's billing actions (production).
import os from 'node:os';
import pg from 'pg';
import { describeTarget, grantLog, grantPlan, isCalendarDate, revokeGrant, type Target } from '../src/billing/staffGrant.js';
import { loadDevEnv } from '../src/config/devEnv.js';

export { isCalendarDate, type Target };

export type GrantArgs =
	| { mode: 'grant'; target: Target; plan: string; until: string | null; reason: string; by: string; replace: boolean; seats: number | null }
	| { mode: 'revoke'; target: Target; reason: string; by: string }
	| { mode: 'list'; target: Target };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_FLAGS = new Set(['--until', '--reason', '--by', '--seats']);
const BARE_FLAGS = new Set(['--revoke', '--list', '--replace']);
export const USAGE = [
	'usage: pnpm dev:billing:grant <email|team-id> <plan> [--until YYYY-MM-DD] [--seats n] --reason "…" [--replace] [--by <name>]',
	'       pnpm dev:billing:grant <email|team-id> --revoke --reason "…" [--by <name>]',
	'       pnpm dev:billing:grant <email|team-id> --list'
].join('\n');

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
		if (flags.has('--until') || flags.has('--seats') || bare.has('--replace')) return '--revoke takes no --until, --seats or --replace';
		if (!reason) return 'give the reason with --reason (it goes into the grant log, which the account can read)';
		return { mode: 'revoke', target, reason, by };
	}
	if (!plan) return 'give the plan to grant (pro or team)';
	if (extra) return `unexpected argument ${extra}`;
	const until = flags.get('--until') ?? null;
	if (until !== null && !isCalendarDate(until)) return '--until is a date, YYYY-MM-DD (the grant lasts through that day, SAST)';
	const seatsText = flags.get('--seats');
	if (seatsText !== undefined && !/^[1-9][0-9]{0,5}$/.test(seatsText)) return '--seats is a whole number of editor seats in all (at least the plan includes)';
	const seats = seatsText === undefined ? null : Number(seatsText);
	if (!reason) return 'give the reason with --reason (it goes into the grant log, which the account can read)';
	return { mode: 'grant', target, plan: plan.toLowerCase(), until, reason, by, replace: bare.has('--replace'), seats };
}

/** Run one command on the schema owner's connection `url`; returns the lines to print (the operator's terminal). */
export async function runGrant(url: string, args: GrantArgs): Promise<string[]> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	const who = describeTarget(args.target);
	try {
		if (args.mode === 'list') {
			const { accountId, planNow, log } = await grantLog(client, args.target);
			if (!accountId) return [`${who} has no billing account (Free, never granted).`];
			return [
				`${who}: on ${planNow} now.`,
				...(log.length ? log.map((r) => `${r.at} SAST  ${r.action.padEnd(6)} ${r.plan.padEnd(5)} ends ${r.until ? `${r.until} SAST` : 'when revoked'}  by ${r.by}: ${r.reason}`) : ['No grants logged.'])
			];
		}
		if (args.mode === 'revoke') {
			const { plan } = await revokeGrant(client, args);
			return [`Revoked ${who}’s ${plan} grant; the account is on Free now. Logged: ${args.reason}`];
		}
		const { endsAt } = await grantPlan(client, args);
		const until = endsAt ? `through ${args.until} (it ends ${endsAt} SAST)` : 'until revoked';
		return [`Granted ${args.plan} to ${who} ${until}${args.replace ? ', replacing its live subscription' : ''}. Logged: ${args.reason}`];
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
