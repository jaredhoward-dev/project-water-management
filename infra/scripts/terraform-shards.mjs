#!/usr/bin/env node
// Which infra/tests/*.tftest.hcl files one CI shard runs (terraform.yml's
// matrix, bin/check-infra.sh with CHECK_INFRA_SHARD=<i>/<n>). Every run block
// is a full plan of the root module, so on CI's 4-CPU runner the whole suite
// is bound by its total CPU, not by one file (infra/README.md § Validating
// locally): the files are split across runners, packed so the shards come out
// even.
//
// Packing: longest-processing-time first. Files sorted by weight (heaviest
// first, then by name), each to the shard with the least weight so far (the
// lowest shard number on a tie), so every shard computes the same plan from
// the same tree and each file lands in exactly one shard. A file's weight is
// its measured CPU seconds in infra/tests/shard-weights.json; a file not
// listed there (a new one) weighs its size times the listed files' mean
// seconds per byte, so it still packs sensibly until the next measurement.
//
//   node infra/scripts/terraform-shards.mjs <i>/<n> [tests dir]
//
// prints shard i's files, one `tests/<name>.tftest.hcl` per line, in the
// order to start them (heaviest first). Exit 2 on a bad spec.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} spec  "<i>/<n>", 1 ≤ i ≤ n
 * @returns {{ index: number, total: number }}
 */
export function parseShard(spec) {
	const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(spec ?? '').trim());
	if (!m) throw new Error(`shard spec "${spec}" is not <i>/<n>`);
	const index = Number(m[1]);
	const total = Number(m[2]);
	if (index > total) throw new Error(`shard ${index} is past the ${total} shards`);
	return { index, total };
}

/**
 * Longest-processing-time packing.
 * @param {{ name: string, weight: number }[]} files
 * @param {number} total
 * @returns {{ names: string[], weight: number }[]} one entry per shard
 */
export function pack(files, total) {
	const shards = Array.from({ length: total }, () => ({ names: /** @type {string[]} */ ([]), weight: 0 }));
	const sorted = [...files].sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const f of sorted) {
		let best = 0;
		for (let i = 1; i < total; i++) if (shards[i].weight < shards[best].weight) best = i;
		shards[best].names.push(f.name);
		shards[best].weight += f.weight;
	}
	return shards;
}

/**
 * Each test file's weight: measured seconds, or its size at the measured
 * files' mean seconds per byte.
 * @param {{ name: string, bytes: number }[]} files
 * @param {Record<string, number>} measured  file name → CPU seconds
 */
export function weigh(files, measured) {
	const known = files.filter((f) => typeof measured[f.name] === 'number' && measured[f.name] > 0);
	const bytes = known.reduce((s, f) => s + f.bytes, 0);
	const secs = known.reduce((s, f) => s + measured[f.name], 0);
	const perByte = bytes > 0 ? secs / bytes : 1;
	return files.map((f) => ({ name: f.name, weight: typeof measured[f.name] === 'number' && measured[f.name] > 0 ? measured[f.name] : f.bytes * perByte }));
}

/** @param {string} testsDir */
export function readTests(testsDir) {
	const files = readdirSync(testsDir)
		.filter((f) => f.endsWith('.tftest.hcl'))
		.map((f) => ({ name: f, bytes: statSync(join(testsDir, f)).size }));
	const weightsFile = join(testsDir, 'shard-weights.json');
	const measured = existsSync(weightsFile) ? JSON.parse(readFileSync(weightsFile, 'utf8')).cpuSeconds ?? {} : {};
	return weigh(files, measured);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		const { index, total } = parseShard(process.argv[2]);
		const dir = process.argv[3] ?? join(new URL('.', import.meta.url).pathname, '..', 'tests');
		const shard = pack(readTests(dir), total)[index - 1];
		for (const name of shard.names) console.log(`tests/${name}`);
	} catch (e) {
		console.error(`terraform-shards: ${e instanceof Error ? e.message : e}`);
		process.exit(2);
	}
}
