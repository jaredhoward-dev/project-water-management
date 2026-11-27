// infra/scripts/terraform-shards.mjs: CI's Terraform shards (terraform.yml)
// cover every test file exactly once, come out even, and agree between runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pack, parseShard, readTests, weigh } from './terraform-shards.mjs';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, 'terraform-shards.mjs');
const realTests = join(here, '..', 'tests');
const SHARDS = 4; // terraform.yml's matrix

test('parses <i>/<n> and refuses anything else', () => {
	assert.deepEqual(parseShard('2/4'), { index: 2, total: 4 });
	for (const bad of ['0/4', '5/4', '4', '1/0', 'a/b', '', '1/4/2', ' 1/ 4']) assert.throws(() => parseShard(bad), bad);
});

test('packs longest first onto the lightest shard, ties to the lower shard and name', () => {
	const shards = pack(
		[
			{ name: 'a', weight: 5 },
			{ name: 'b', weight: 4 },
			{ name: 'c', weight: 3 },
			{ name: 'd', weight: 3 },
			{ name: 'e', weight: 1 },
		],
		2,
	);
	assert.deepEqual(shards, [
		{ names: ['a', 'd'], weight: 8 },
		{ names: ['b', 'c', 'e'], weight: 8 },
	]);
	// More shards than files: the extra shards are empty, not an error.
	assert.deepEqual(pack([{ name: 'a', weight: 1 }], 3).map((s) => s.names), [['a'], [], []]);
});

test('a file with no measurement weighs its size at the measured mean seconds per byte', () => {
	const w = weigh(
		[
			{ name: 'a', bytes: 100 },
			{ name: 'b', bytes: 300 },
			{ name: 'new', bytes: 200 },
		],
		{ a: 10, b: 30 },
	);
	assert.deepEqual(w, [
		{ name: 'a', weight: 10 },
		{ name: 'b', weight: 30 },
		{ name: 'new', weight: 20 },
	]);
	// Nothing measured: size alone.
	assert.deepEqual(weigh([{ name: 'a', bytes: 7 }], {}), [{ name: 'a', weight: 7 }]);
});

test('the real suite: every file in exactly one shard, and no shard past 1.25 times the mean', () => {
	const files = readTests(realTests);
	const shards = pack(files, SHARDS);
	const names = shards.flatMap((s) => s.names).sort();
	assert.deepEqual(names, files.map((f) => f.name).sort());
	assert.equal(new Set(names).size, names.length);
	const mean = files.reduce((s, f) => s + f.weight, 0) / SHARDS;
	for (const [i, s] of shards.entries()) assert.ok(s.weight <= mean * 1.25, `shard ${i + 1} weighs ${s.weight.toFixed(0)}, mean ${mean.toFixed(0)}`);
});

test('shard-weights.json names only test files that exist', () => {
	const files = new Set(readTests(realTests).map((f) => f.name));
	const { cpuSeconds } = JSON.parse(readFileSync(join(realTests, 'shard-weights.json'), 'utf8'));
	for (const name of Object.keys(cpuSeconds)) assert.ok(files.has(name), `shard-weights.json lists ${name}, which is gone`);
});

test('the CLI prints one shard, the same on every call, and exits 2 on a bad spec', () => {
	const dir = mkdtempSync(join(tmpdir(), 'tf-shards-'));
	for (const [n, size] of [['a', 50], ['b', 40], ['c', 30]]) writeFileSync(join(dir, `${n}.tftest.hcl`), 'x'.repeat(size));
	const run = (spec) => spawnSync(process.execPath, [script, spec, dir], { encoding: 'utf8' });
	assert.equal(run('1/2').stdout, 'tests/a.tftest.hcl\n');
	assert.equal(run('2/2').stdout, 'tests/b.tftest.hcl\ntests/c.tftest.hcl\n');
	assert.equal(run('2/2').stdout, run('2/2').stdout);
	const bad = run('3/2');
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /past the 2 shards/);
});
