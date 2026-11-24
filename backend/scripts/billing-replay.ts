// Sign a synthetic billing event with the committed dev-only key and post it to
// the local API's mock webhook (issue #641 Phase 3, docs/billing.md § Webhooks
// and providers, docs/run-locally.md § Billing webhooks):
//
//   pnpm dev:billing:replay <fixture> [--account <billing account id>] [--new-id]
//
// <fixture> is a name under backend/fixtures/billing/ (subscription-updated) or a
// path to a Stripe-shaped event. --account puts that billing account's id in the
// event's metadata (find one with pnpm dev:db:psql: SELECT id FROM billing_account);
// --new-id gives the event a fresh id, since a replayed id is a `duplicate`.
// The timestamp is now, so the signature is fresh.
//
// It signs only with a dev-only- key and posts only to a local API (WM_API_URL,
// default http://localhost:3001), and the backend must run BILLING_PROVIDER=mock
// (the default). It prints the HTTP status and the API's answer, never the key.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { signPayload, SIGNATURE_HEADER } from '../src/billing/provider/signature.js';
import { loadDevEnv } from '../src/config/devEnv.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'billing');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** The fixture's path: a bare name under backend/fixtures/billing/, else a path from where pnpm was run. */
export function fixturePath(arg: string, cwd = process.env.INIT_CWD ?? process.cwd()): string {
	if (/^[a-z0-9-]+$/.test(arg)) return join(FIXTURES, `${arg}.json`);
	return isAbsolute(arg) ? arg : resolve(cwd, arg);
}

/** The event with its account and id replaced as asked, serialised as it will be signed and sent. */
export function prepareEvent(event: Record<string, unknown>, opts: { account?: string; newId?: boolean }, now = Date.now()): string {
	const out = structuredClone(event);
	if (opts.newId) out.id = `evt_replay_${now.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
	if (opts.account) {
		const setIn = (o: unknown) => {
			if (o && typeof o === 'object' && !Array.isArray(o)) {
				for (const [k, v] of Object.entries(o)) {
					if (k === 'metadata' && v && typeof v === 'object' && 'billing_account_id' in v) (v as Record<string, unknown>).billing_account_id = opts.account;
					else setIn(v);
				}
			}
		};
		setIn(out);
	}
	return JSON.stringify(out);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--account');
	const ai = argv.indexOf('--account');
	const account = ai >= 0 ? argv[ai + 1] : undefined;
	if (!file || (ai >= 0 && !UUID.test(account ?? ''))) {
		console.error('usage: pnpm dev:billing:replay <fixture> [--account <billing account uuid>] [--new-id]');
		return 2;
	}
	const path = fixturePath(file);
	if (!existsSync(path)) {
		console.error(`no such fixture: ${path}`);
		return 2;
	}
	if ((env.BILLING_PROVIDER?.trim() || 'mock') !== 'mock') {
		console.error('BILLING_PROVIDER is not mock: this script only posts to the mock webhook.');
		return 2;
	}
	const secret = env.BILLING_WEBHOOK_SECRET ?? '';
	if (!secret.startsWith('dev-only-')) {
		console.error('BILLING_WEBHOOK_SECRET is not the dev-only- key (backend/.env.development): refusing to sign with anything else.');
		return 2;
	}
	const api = (env.WM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
	if (!LOCAL.test(new URL(api).hostname)) {
		console.error('WM_API_URL is not a local API: this script posts only to localhost.');
		return 2;
	}
	const body = prepareEvent(JSON.parse(readFileSync(path, 'utf8')), { account, newId: argv.includes('--new-id') });
	const res = await fetch(`${api}/billing/webhook/mock`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signPayload(secret, body, Date.now() / 1000) },
		body
	});
	console.log(`${res.status} ${await res.text()}`);
	return res.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	process.exitCode = await main(process.argv.slice(2));
}
