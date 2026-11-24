// secret-scan.yml's Report findings step (scripts/ci/secret_scan_report.py),
// run as the step runs it: python3 -I, with RESULTS, REVIEWED and
// GITHUB_STEP_SUMMARY set, from a checkout. All findings here are invented.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = new URL('./secret_scan_report.py', import.meta.url).pathname;
const REAL_REVIEWED = new URL('../../.github/secret-scan-reviewed.txt', import.meta.url).pathname;

function git(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

// A throwaway repo with two commits, so entries can name real commits.
function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
	git(dir, 'init', '-q');
	for (const n of [1, 2]) {
		writeFileSync(join(dir, 'f.txt'), `${n}\n`);
		git(dir, 'add', 'f.txt');
		git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `c${n}`);
	}
	return { dir, head: git(dir, 'rev-parse', 'HEAD'), first: git(dir, 'rev-parse', 'HEAD~1') };
}

const repo = makeRepo();
const OTHER = 'a'.repeat(40); // in no history

function finding({ commit = repo.head, file = 'backend/x.test.ts', line = 12, detector = 'Postgres', verified = false, error = '' } = {}) {
	return JSON.stringify({
		DetectorName: detector,
		Verified: verified,
		VerificationError: error,
		SourceMetadata: { Data: { Git: { commit, file, line } } },
	});
}

const unknown = (o = {}) => finding({ error: 'lookup db.example.org: no such host', ...o });

/** Run the script; `reviewed` null means no reviewed file, `results` null no results file. */
function run({ results = [], reviewed = null, cwd = repo.dir } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'secret-scan-run-'));
	const env = { ...process.env, RESULTS: join(dir, 'trufflehog.jsonl'), REVIEWED: join(dir, 'reviewed.txt'), GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
	if (results !== null) writeFileSync(env.RESULTS, results.map((r) => r + '\n').join(''));
	if (reviewed !== null) writeFileSync(env.REVIEWED, reviewed);
	const r = spawnSync('python3', ['-I', SCRIPT], { cwd, env, encoding: 'utf8' });
	const summary = existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') : '';
	return { code: r.status, out: r.stdout, err: r.stderr, summary };
}

const entry = ({ commit = repo.head, file = 'backend/x.test.ts', line = 12, detector = 'Postgres' } = {}) => `${commit} ${file} ${line} ${detector}  # synthetic host\n`;

test('a listed unknown finding is reviewed (a notice) and does not fail', () => {
	const r = run({ results: [unknown()], reviewed: entry() });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^::notice file=backend\/x\.test\.ts,line=12::reviewed Postgres credential in commit /m);
	assert.match(r.summary, /\*\*0 verified\/unknown\*\*.*\*\*1 reviewed\*\*/);
	assert.match(r.summary, /\| reviewed \| Postgres \| `backend\/x\.test\.ts` \| 12 \|/);
});

test('the same unknown finding unlisted fails (positive control for the line above)', () => {
	const r = run({ results: [unknown()], reviewed: null });
	assert.equal(r.code, 1);
	assert.match(r.out, /^::error file=backend\/x\.test\.ts,line=12::unknown Postgres/m);
	assert.match(r.summary, /\*\*1 verified\/unknown\*\*/);
});

test('a listed verified finding still fails: verified means live', () => {
	const r = run({ results: [finding({ verified: true })], reviewed: entry() });
	assert.equal(r.code, 1);
	assert.match(r.out, /^::error file=backend\/x\.test\.ts,line=12::verified Postgres/m);
	assert.doesNotMatch(r.out, /reviewed/);
});

test('an entry covers only its exact commit, file, line and detector', () => {
	for (const other of [{ commit: repo.first }, { file: 'backend/y.test.ts' }, { line: 13 }, { detector: 'URI' }]) {
		const r = run({ results: [unknown(other)], reviewed: entry() });
		assert.equal(r.code, 1, JSON.stringify(other));
		assert.match(r.out, /::error .*::unknown /, JSON.stringify(other));
	}
});

test('an unverified finding only warns, listed or not', () => {
	const r = run({ results: [finding({ line: 40 })], reviewed: entry() });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^::warning file=backend\/x\.test\.ts,line=40::unverified Postgres/m);
});

test('a malformed entry fails before any finding is judged', () => {
	for (const bad of ['abc123 backend/x.test.ts 12 Postgres\n', `${repo.head} backend/x.test.ts twelve Postgres\n`, `${repo.head} backend/x.test.ts 12\n`, `${repo.head} a b 12 Postgres\n`]) {
		const r = run({ results: [unknown()], reviewed: bad });
		assert.notEqual(r.code, 0, bad);
		assert.match(r.err, /reviewed\.txt: bad entry /, bad);
	}
});

test('comments and blank lines are skipped', () => {
	const r = run({ results: [unknown()], reviewed: `# header\n\n   \n  # indented comment\n${entry()}` });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /::notice .*::reviewed /);
});

test('without the reviewed file the scan reports as before', () => {
	const clean = run({ results: [], reviewed: null });
	assert.equal(clean.code, 0, clean.err);
	assert.match(clean.summary, /^## secret scan \(trufflehog\)\n\nNo secrets found\.\n$/);
	const mixed = run({ results: ['not json, a log line', finding({ line: 3 }), unknown()], reviewed: null });
	assert.equal(mixed.code, 1);
	// Failing rows first, and no value or secret field ever reaches the output.
	assert.ok(mixed.out.indexOf('::error') < mixed.out.indexOf('::warning'));
	assert.match(mixed.summary, /\*\*1 verified\/unknown\*\*.*\*\*1 unverified\*\*.*\*\*0 reviewed\*\*/);
});

test('a missing results file fails with a summary pointing at the scan', () => {
	const r = run({ results: null });
	assert.equal(r.code, 1);
	assert.equal(r.summary, '## secret scan\nNo results file; see the Install and Scan steps.\n');
});

test('an entry naming a commit that is not in the history fails', () => {
	const r = run({ results: [], reviewed: entry() + entry({ commit: OTHER }) });
	assert.equal(r.code, 1);
	assert.match(r.out, new RegExp(`^::error file=.*reviewed\\.txt::.* lists commit ${OTHER}, which is not in this clone's history`, 'm'));
	assert.doesNotMatch(r.out, new RegExp(repo.head));
});

test('a shallow clone skips the commit check', () => {
	const shallow = mkdtempSync(join(tmpdir(), 'secret-scan-shallow-'));
	git(shallow, 'clone', '-q', '--depth', '1', `file://${repo.dir}`, '.');
	const r = run({ results: [unknown({ commit: repo.first })], reviewed: entry({ commit: repo.first }), cwd: shallow });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /Shallow clone: not checking/);
	assert.match(r.out, /::notice .*::reviewed /);
});

test("this repo's reviewed file parses, and its commits exist unless the clone is shallow", () => {
	const root = new URL('../..', import.meta.url).pathname;
	const r = run({ results: [], reviewed: readFileSync(REAL_REVIEWED, 'utf8'), cwd: root });
	assert.equal(r.code, 0, r.out + r.err);
});
