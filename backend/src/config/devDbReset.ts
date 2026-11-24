// `pnpm dev:db:reset` (scripts/db-reset.ts): drop and recreate this checkout's
// own dev database, then migrate it. Every checkout's dev database (`water`, a
// worktree's water_w<tag>), every test and e2e database, and MinIO's and
// Mailpit's data share one docker Postgres and its volumes, so the reset
// touches nothing but the one database this checkout owns (devEnv.ts). It once
// ran `docker compose down -v`, which wiped every other checkout's databases
// too; that is `pnpm dev:docker:wipe` now.
//
// resetTarget is the guard, kept apart from the CLI so a unit test covers it
// without Docker: it refuses anything but a local docker URL that names this
// checkout's own database.
import { DOCKER_DB_PORT, LOCAL_HOSTS, DB_NAME, devDbName } from './devEnv.js';

/** Databases a dev reset never drops, whatever the env says: the container's maintenance databases and the test and e2e ones. */
const NEVER = /^(postgres|template[01]|water_test(_w[0-9a-f]+)?|water_e2e(_.*)?)$/;

/**
 * The database a reset of this checkout may drop: its own name by where it is
 * (devEnv.ts devDbName), never DEV_DB_NAME's, since that override can point a
 * worktree at the main checkout's `water` or another checkout's database.
 */
export function ownDevDbName(here: { path: string; isWorktree: boolean }, env: NodeJS.ProcessEnv = process.env): string {
	const own = devDbName(here.path, here.isWorktree);
	const override = env.DEV_DB_NAME?.trim();
	if (override && override !== own)
		throw new Error(
			`DEV_DB_NAME=${override} points this checkout at a database that isn't its own (${own}); ` +
				'dev:db:reset only resets its own. Unset DEV_DB_NAME to reset this checkout’s database.'
		);
	return own;
}

export interface ResetTarget {
	/** The database to drop and recreate. */
	name: string;
	/** The same server's `postgres` database, to run DROP/CREATE DATABASE from. */
	adminUrl: string;
	/** host:port, for the message. */
	server: string;
}

/** Where `ownerUrl` points, if it is this checkout's own dev database on the local docker Postgres; otherwise it throws. */
export function resetTarget(ownerUrl: string, own: string): ResetTarget {
	let parsed: URL;
	try {
		parsed = new URL(ownerUrl);
	} catch {
		throw new Error('MIGRATION_DATABASE_URL is not a URL');
	}
	if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error(`refusing to reset: ${parsed.protocol} is not a Postgres URL`);
	if (!LOCAL_HOSTS.has(parsed.hostname))
		throw new Error(`refusing to reset a database on ${parsed.hostname}: dev:db:reset only resets the local docker Postgres (127.0.0.1:${DOCKER_DB_PORT})`);
	if (parsed.port !== DOCKER_DB_PORT)
		throw new Error(
			`refusing to reset a database on port ${parsed.port || '5432'}: the docker Postgres is on ${DOCKER_DB_PORT} (another Postgres on this machine isn't ours to drop)`
		);
	const name = decodeURIComponent(parsed.pathname.slice(1));
	if (!DB_NAME.test(name) || NEVER.test(name)) throw new Error(`refusing to reset database ${JSON.stringify(name)}: not a dev database`);
	if (name !== own)
		throw new Error(`refusing to reset database ${name}: this checkout's dev database is ${own}, and dev:db:reset never touches another checkout's`);
	const admin = new URL(parsed.toString());
	admin.pathname = '/postgres';
	return { name, adminUrl: admin.toString(), server: `${parsed.hostname}:${parsed.port}` };
}
