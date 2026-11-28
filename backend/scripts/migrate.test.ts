// The migration runner's forward-only rules and per-file directives, without a
// database. Against Postgres (bootstrap, backfill, timeouts):
// src/db/migrate.db.test.ts.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checksumOf, MIGRATIONS_DIR, parseDirectives, planMigrations, type AppliedRow, type MigrationFile } from './migrate.js';

const file = (name: string, sql = `-- ${name}`): MigrationFile => ({ name, checksum: checksumOf(sql) });
const row = (f: MigrationFile, checksum: string | null = f.checksum): AppliedRow => ({ name: f.name, checksum });

describe('planMigrations', () => {
	const a = file('001_init.sql');
	const b = file('002_more.sql');
	const c = file('003_last.sql');

	it('a fresh database: everything pending, in order', () => {
		expect(planMigrations([a, b, c], [])).toEqual({ pending: [a, b, c], backfill: [], newer: [], problems: [] });
	});

	it('an up-to-date database: nothing to do', () => {
		expect(planMigrations([a, b], [row(a), row(b)])).toEqual({ pending: [], backfill: [], newer: [], problems: [] });
	});

	it('only files after the latest applied one are pending', () => {
		expect(planMigrations([a, b, c], [row(a), row(b)]).pending).toEqual([c]);
	});

	it('refuses an applied file whose contents changed, naming it', () => {
		const edited = file('002_more.sql', 'ALTER TABLE x ADD COLUMN y int;');
		const { problems } = planMigrations([a, edited, c], [row(a), row(b)]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/^002_more\.sql was applied but its contents have changed/);
	});

	it('refuses an applied migration whose file is gone', () => {
		const { problems } = planMigrations([a, c], [row(a), row(b), row(c)]);
		expect(problems).toEqual([expect.stringMatching(/^002_more\.sql was applied but its file is missing/)]);
	});

	it('refuses a pending file that sorts before the latest applied one', () => {
		const late = file('002a_merged_late.sql');
		const { problems, pending } = planMigrations([a, b, late, c], [row(a), row(b), row(c)]);
		expect(pending).toEqual([late]);
		expect(problems).toEqual([expect.stringMatching(/^002a_merged_late\.sql is pending but sorts before 003_last\.sql/)]);
	});

	it('refuses two files with the same number, naming both (positive control: distinct numbers pass)', () => {
		const twin = file('002_other.sql');
		const { problems } = planMigrations([a, b, twin, c], []);
		expect(problems).toEqual(['002_more.sql and 002_other.sql share the number 002 (renumber the later one after the highest)']);
		expect(planMigrations([a, b, c], []).problems).toEqual([]);
	});

	it('the checked-in migrations have one file per number', () => {
		const names = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f));
		expect(names.length).toBeGreaterThan(100);
		expect(planMigrations(names.map((n) => file(n)), []).problems).toEqual([]);
	});

	it('backfills rows recorded before checksums instead of refusing them', () => {
		const plan = planMigrations([a, b, c], [row(a, null), row(b, null)]);
		expect(plan).toEqual({ pending: [c], backfill: [a, b], newer: [], problems: [] });
	});

	it('reports every problem at once', () => {
		const edited = file('001_init.sql', 'changed');
		// c keeps 002 at or below the highest file, so its absence is a problem, not a newer release's.
		const { problems } = planMigrations([edited, file('000_early.sql'), c], [row(a), row(b)]);
		expect(problems).toHaveLength(3);
	});

	describe('a database ahead of this code (a rollback deploy)', () => {
		const d = file('004_newer.sql');
		const e = file('005_newest.sql');

		it('skips applied names after the highest file instead of refusing them', () => {
			expect(planMigrations([a, b], [row(a), row(b), row(c), row(d)])).toEqual({ pending: [], backfill: [], newer: ['003_last.sql', '004_newer.sql'], problems: [] });
		});

		it('still refuses a missing file at or below the highest file (positive control: the newer ones alone pass)', () => {
			const { problems, newer } = planMigrations([a, c], [row(a), row(b), row(c), row(d), row(e)]);
			expect(newer).toEqual(['004_newer.sql', '005_newest.sql']);
			expect(problems).toEqual([expect.stringMatching(/^002_more\.sql was applied but its file is missing/)]);
		});

		it('still refuses an edited file below the newer ones', () => {
			const edited = file('002_more.sql', 'changed');
			const { problems, newer } = planMigrations([a, edited], [row(a), row(b), row(d)]);
			expect(newer).toEqual(['004_newer.sql']);
			expect(problems).toEqual([expect.stringMatching(/^002_more\.sql was applied but its contents have changed/)]);
		});

		it('still refuses a file of its own the database never applied (pending before a newer applied one)', () => {
			const { problems, pending } = planMigrations([a, b, c], [row(a), row(b), row(d)]);
			expect(pending).toEqual([c]);
			expect(problems).toEqual([expect.stringMatching(/^003_last\.sql is pending but sorts before 004_newer\.sql/)]);
		});

		it('with no files at all, an applied name is missing, not newer', () => {
			const { problems, newer } = planMigrations([], [row(a)]);
			expect(newer).toEqual([]);
			expect(problems).toEqual([expect.stringMatching(/^001_init\.sql was applied but its file is missing/)]);
		});
	});

	it('orders by code unit, the same order the files are applied in', () => {
		// Plain string order, not numeric: '0100_y.sql' < '010_x.sql' ('0' < '_'), so 010_x is after it.
		const x = file('010_x.sql');
		const y = file('0100_y.sql');
		expect(planMigrations([y, x], [row(y)]).problems).toEqual([]);
	});
});

describe('checksumOf', () => {
	it('is the sha256 hex of the contents, sensitive to any byte', () => {
		expect(checksumOf('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(checksumOf('SELECT 1;\n')).not.toBe(checksumOf('SELECT 1;\r\n'));
	});
});

describe('parseDirectives', () => {
	it('reads either timeout from a comment line', () => {
		expect(parseDirectives('-- migrate: statement_timeout = 900s\n--migrate:lock_timeout=30s\nSELECT 1;')).toEqual({
			statement_timeout: '900s',
			lock_timeout: '30s'
		});
	});

	it('accepts 0 (no limit) and the other units', () => {
		expect(parseDirectives('-- migrate: statement_timeout = 0')).toEqual({ statement_timeout: '0' });
		expect(parseDirectives('-- migrate: statement_timeout = 15min')).toEqual({ statement_timeout: '15min' });
	});

	it('ignores ordinary SQL and comments', () => {
		expect(parseDirectives("SET statement_timeout = '1s'; -- migrate: statement_timeout = 9s\n-- the migrate step")).toEqual({});
	});

	it('refuses a value that is not a plain duration', () => {
		expect(() => parseDirectives("-- migrate: statement_timeout = 1s';DROP")).toThrow(/bad migrate directive/);
		expect(() => parseDirectives('-- migrate: lock_timeout = forever')).toThrow(/bad migrate directive/);
	});
});
