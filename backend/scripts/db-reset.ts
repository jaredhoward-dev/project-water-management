// `pnpm dev:db:reset`: drop and recreate this checkout's own dev database
// (`water` in the main checkout, a worktree's water_w<tag>; src/config/devEnv.ts)
// as the schema owner, then apply every migration. Nothing else in the shared
// docker Postgres is touched: not another checkout's database, not the test or
// e2e ones, not MinIO's or Mailpit's volumes. src/config/devDbReset.ts is the
// guard: a non-local URL, another port, or a database that isn't this
// checkout's is refused before anything is dropped.
//
// A database with open connections (this checkout's `pnpm dev` or worker) is
// refused rather than force-closed: stop them first.
import pg from 'pg';
import { thisCheckout } from '../src/config/checkout.js';
import { ownDevDbName, resetTarget } from '../src/config/devDbReset.js';
import { loadDevEnv } from '../src/config/devEnv.js';
import { migrate } from './migrate.js';

async function main(): Promise<void> {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
	const target = resetTarget(url, ownDevDbName(thisCheckout()));
	console.log(`resetting this checkout's dev database ${target.name} on ${target.server}`);

	const admin = new pg.Client({ connectionString: target.adminUrl });
	await admin.connect();
	try {
		const { rows } = await admin.query<{ n: number }>(
			'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
			[target.name]
		);
		const open = rows[0]?.n ?? 0;
		if (open > 0)
			throw new Error(
				`${target.name} has ${open} open connection(s): stop this checkout's pnpm dev, worker or psql first (the reset never closes them for you)`
			);
		// The name passed the guard's DB_NAME pattern, so quoting it is enough.
		await admin.query(`DROP DATABASE IF EXISTS "${target.name}"`);
		await admin.query(`CREATE DATABASE "${target.name}" OWNER water`);
	} finally {
		await admin.end().catch(() => {});
	}

	const applied = await migrate(url);
	console.log(
		`reset ${target.name}: recreated, ${applied.length} migration(s) applied. It is empty: \`pnpm seed:examples\` adds the demo catchments, ` +
			'and the import:* steps of `pnpm run setup` the reference datasets.'
	);
}

main().catch((err: Error) => {
	console.error(`dev:db:reset: ${err.message}`);
	process.exit(1);
});
