// The dev:db:reset guard (config/devDbReset.ts): it resets only this
// checkout's own dev database on the local docker Postgres, and refuses
// everything else before anything is dropped. No Docker needed.
import { describe, expect, it } from 'vitest';
import { testDbName } from '../__tests__/test-db.js';
import { ownDevDbName, resetTarget } from './devDbReset.js';
import { devDbName } from './devEnv.js';

const MAIN = { path: '/home/x/project-water-management', isWorktree: false };
const TREE = { path: '/home/x/wm-a', isWorktree: true };
const OTHER_TREE = { path: '/home/x/wm-b', isWorktree: true };
const own = devDbName(TREE.path, true);
const owner = (db: string, host = '127.0.0.1', port = '5434') => `postgresql://water:water@${host}:${port}/${db}`;

describe('ownDevDbName', () => {
	it('is water in the main checkout and water_w<tag> in a worktree', () => {
		expect(ownDevDbName(MAIN, {})).toBe('water');
		expect(ownDevDbName(TREE, {})).toBe(own);
		expect(own).toMatch(/^water_w[0-9a-f]{16}$/);
	});

	it('accepts a DEV_DB_NAME that names its own database', () => {
		expect(ownDevDbName(TREE, { DEV_DB_NAME: own })).toBe(own);
	});

	it('refuses a DEV_DB_NAME that points a worktree at the main checkout’s or another database', () => {
		expect(() => ownDevDbName(TREE, { DEV_DB_NAME: 'water' })).toThrow(/isn't its own/);
		expect(() => ownDevDbName(TREE, { DEV_DB_NAME: devDbName(OTHER_TREE.path, true) })).toThrow(/isn't its own/);
		expect(() => ownDevDbName(MAIN, { DEV_DB_NAME: 'water_mine' })).toThrow(/isn't its own/);
	});
});

describe('resetTarget', () => {
	it('resets the checkout’s own database, through the same server’s postgres database', () => {
		const t = resetTarget(owner(own), own);
		expect(t.name).toBe(own);
		expect(t.server).toBe('127.0.0.1:5434');
		const admin = new URL(t.adminUrl);
		expect(admin.pathname).toBe('/postgres');
		expect(`${admin.hostname}:${admin.port}`).toBe('127.0.0.1:5434');
		expect(resetTarget(owner('water', 'localhost'), 'water').name).toBe('water');
	});

	it('refuses another checkout’s dev database (positive control above: its own passes)', () => {
		expect(() => resetTarget(owner('water'), own)).toThrow(/this checkout's dev database is/);
		expect(() => resetTarget(owner(devDbName(OTHER_TREE.path, true)), own)).toThrow(/never touches another checkout's/);
		expect(() => resetTarget(owner(own), 'water')).toThrow(/never touches another checkout's/);
	});

	it('refuses the test, e2e and maintenance databases even when the env names them as its own', () => {
		for (const db of ['water_test', testDbName(TREE.path, true), 'water_e2e', 'water_e2e_w3', 'postgres', 'template1'])
			expect(() => resetTarget(owner(db), db)).toThrow(/not a dev database/);
	});

	it('refuses anything but the local docker Postgres', () => {
		expect(() => resetTarget(owner(own, 'db.example.com'), own)).toThrow(/only resets the local docker Postgres/);
		expect(() => resetTarget(owner(own, 'mydb.abc123.eu-west-1.rds.amazonaws.com'), own)).toThrow(/local docker Postgres/);
		expect(() => resetTarget(owner(own, '127.0.0.1', '5432'), own)).toThrow(/port 5432/);
		expect(() => resetTarget(owner(own, '127.0.0.1', '5433'), own)).toThrow(/port 5433/);
		expect(() => resetTarget(`postgresql://water:water@127.0.0.1/${own}`, own)).toThrow(/port 5432/);
	});

	it('refuses a malformed URL or name', () => {
		expect(() => resetTarget('not a url', own)).toThrow(/not a URL/);
		expect(() => resetTarget(`mysql://water:water@127.0.0.1:5434/${own}`, own)).toThrow(/not a Postgres URL/);
		expect(() => resetTarget(owner('Water"; DROP'), 'Water"; DROP')).toThrow(/not a dev database/);
	});
});
