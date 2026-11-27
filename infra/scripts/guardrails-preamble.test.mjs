// The guardrail tests are split across infra/tests/guardrails_*.tftest.hcl so
// bin/check-infra.sh runs them in parallel (`terraform test` runs one file's
// run blocks one by one, and the single guardrails file was the long pole that
// took CI's 10-minute Terraform job past its limit). A test file can't share
// mocks, overrides or variables with another, so each carries the same copy:
// this keeps the copies identical, the run names unique, and every
// `run.<name>.` reference inside the file that defines that run.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const tests = join(new URL('.', import.meta.url).pathname, '..', 'tests');
const files = readdirSync(tests)
	.filter((f) => /^guardrails_[a-z0-9_]+\.tftest\.hcl$/.test(f))
	.sort();
const text = Object.fromEntries(files.map((f) => [f, readFileSync(join(tests, f), 'utf8')]));

// From the first mock_provider block to the end of the top-level variables
// block (the section comments before a file's first run differ, rightly).
function preamble(src) {
	const start = src.search(/^mock_provider /m);
	const vars = src.search(/^variables \{$/m);
	const close = src.indexOf('\n}\n', vars);
	assert.ok(start >= 0 && vars > start && close > vars, 'mock_provider blocks, then a top-level variables block');
	assert.ok(close < src.search(/^run "/m), 'the variables block comes before the first run block');
	return src.slice(start, close + 3);
}

const runNames = (src) => [...src.matchAll(/^run "([^"]+)"/gm)].map((m) => m[1]);

test('the guardrails are split across several files', () => {
	assert.ok(files.length >= 2, `found ${files.join(', ')}`);
	assert.deepEqual(
		readdirSync(tests).filter((f) => f === 'guardrails.tftest.hcl'),
		[],
		'the single guardrails.tftest.hcl is gone; add runs to a guardrails_*.tftest.hcl',
	);
});

test('every guardrails file carries the same mocks, overrides and variables', () => {
	const [first, ...rest] = files;
	for (const f of rest) {
		// A boolean, so a failure names the file rather than printing 20 KB twice.
		assert.ok(preamble(text[f]) === preamble(text[first]), `${f}'s mocks, overrides or variables differ from ${first}'s`);
	}
});

test('run names are unique across the guardrails files', () => {
	const seen = new Map();
	for (const f of files) {
		for (const name of runNames(text[f])) {
			assert.ok(!seen.has(name), `run "${name}" is in both ${seen.get(name)} and ${f}`);
			seen.set(name, f);
		}
	}
});

test('a run only reads the outputs of runs in its own file', () => {
	for (const f of files) {
		const own = new Set(runNames(text[f]));
		for (const m of text[f].matchAll(/\brun\.([a-z0-9_]+)\./g)) {
			assert.ok(own.has(m[1]), `${f} reads run.${m[1]}, defined in another file`);
		}
	}
});
