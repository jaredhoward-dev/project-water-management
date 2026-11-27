// The operator's subscription price conflicts (406, issue #928; docs/billing.md
// § Price check), locally:
//
//   pnpm dev:billing:conflict --list [--all]
//   pnpm dev:billing:conflict --resolve <id> --reason "…" [--by <name>]
//
// As the schema owner (MIGRATION_DATABASE_URL) on this checkout's dev
// database; production runs the same functions as the migrate Lambda's
// billing-conflicts and billing-conflict-resolve owner actions (the
// billing-admin workflow, ids only). --list shows the open ones (with --all,
// the resolved ones too); --resolve marks one resolved once it is dealt with
// in the provider's dashboard, keeping who and why on the row. The logic is
// src/billing/conflicts.ts.
import os from 'node:os';
import pg from 'pg';
import { conflictLine, listConflicts, resolveConflict } from '../src/billing/conflicts.js';
import { loadDevEnv } from '../src/config/devEnv.js';

export type ConflictArgs = { mode: 'list'; all: boolean } | { mode: 'resolve'; id: number; reason: string; by: string };

export const USAGE = ['usage: pnpm dev:billing:conflict --list [--all]', '       pnpm dev:billing:conflict --resolve <id> --reason "…" [--by <name>]'].join('\n');

/** The arguments, or why they can't be taken. `defaultBy` is who acts when --by isn't given (the operator's login). */
export function parseArgs(argv: string[], defaultBy: string): ConflictArgs | string {
	const flags = new Map<string, string>();
	const bare = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--resolve' || a === '--reason' || a === '--by') {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
			flags.set(a, v);
			i++;
		} else if (a === '--list' || a === '--all') bare.add(a);
		else return a.startsWith('--') ? `unknown option ${a}` : `unexpected argument ${a}`;
	}
	if (bare.has('--list') === flags.has('--resolve')) return 'give one of --list and --resolve <id>';
	if (bare.has('--list')) {
		if (flags.size) return '--list takes only --all';
		return { mode: 'list', all: bare.has('--all') };
	}
	if (bare.has('--all')) return '--all goes with --list';
	const idText = flags.get('--resolve')!;
	if (!/^[1-9][0-9]{0,14}$/.test(idText)) return '--resolve takes the conflict’s id (the # in --list)';
	const reason = (flags.get('--reason') ?? '').trim();
	const by = (flags.get('--by') ?? defaultBy).trim();
	if (!reason || reason.length > 500) return 'give why it is resolved with --reason (1–500 characters; no address)';
	if (!by || by.length > 100 || by === 'event') return 'give who resolves it with --by (1–100 characters, not "event")';
	return { mode: 'resolve', id: Number(idText), reason, by };
}

/** Run one command on the schema owner's connection `url`; returns the lines to print. */
export async function runConflict(url: string, args: ConflictArgs): Promise<string[]> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		if (args.mode === 'list') {
			const rows = await listConflicts(client, args.all);
			return rows.length ? rows.map(conflictLine) : [args.all ? 'No billing conflicts.' : 'No open billing conflicts.'];
		}
		const r = await resolveConflict(client, args);
		return [`Resolved billing conflict #${r.id} (${r.externalRef}). Kept on the row: by ${r.resolvedBy}: ${r.resolution}`];
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
	runConflict(url, args)
		.then((lines) => {
			for (const l of lines) console.log(l);
			process.exit(0);
		})
		.catch((err: Error) => {
			console.error(err.message);
			process.exit(1);
		});
}
