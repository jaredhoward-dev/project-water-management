// The disposable-domain list refresh (disposable_domains.mjs, issue #641):
// the vendored file is in the generated form and its header's SHA-256 is its
// list's; upstream lines that aren't lower-case domains (a backtick, `${`,
// a comment) are refused; the ±20 % size guard; and refresh against a fake
// fetch: unchanged at the same commit, rewritten at a new one, refused past
// the guard, and the fetch pinned to the commit the API named. No network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FILE, parseArgs, parseList, readVendored, refresh, render, sizeChangeProblem, UPSTREAM_PATH } from './disposable_domains.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendored = readFileSync(join(ROOT, FILE), 'utf8');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const domains = (n, prefix = 'd') => Array.from({ length: n }, (_, i) => `${prefix}${i}.example`);
const fileAt = (commit, list) => render({ commit, commitDate: '2026-10-01', fetched: '2026-10-02', domains: list, sha256: '0'.repeat(64) });

/** A fetch that answers the commits API with `commit` and the raw file with `text`, recording the URLs. */
function fakeFetch(commit, text) {
	const urls = [];
	const impl = async (url) => {
		urls.push(String(url));
		if (String(url).startsWith('https://api.github.com/')) return new Response(JSON.stringify({ sha: commit, commit: { committer: { date: '2026-11-30T08:00:00Z' } } }));
		if (String(url).startsWith('https://raw.githubusercontent.com/')) return new Response(text);
		return new Response('', { status: 404 });
	};
	return { impl, urls };
}

test('the vendored file is in the generated form, and its header hash is its list', () => {
	const v = readVendored(vendored);
	assert.match(v.commit ?? '', /^[0-9a-f]{40}$/);
	assert.ok(v.commitDate && v.fetched && v.sha256, 'every header field reads');
	assert.equal(render(/** @type {any} */ (v)), vendored);
	assert.equal(createHash('sha256').update(`${v.domains.join('\n')}\n`).digest('hex'), v.sha256);
	assert.deepEqual(parseList(`${v.domains.join('\n')}\n`), v.domains);
});

test('parseList refuses anything but lower-case domains, so nothing can break out of the template literal', () => {
	assert.deepEqual(parseList('a.com\nb.co.za\n'), ['a.com', 'b.co.za']);
	for (const bad of ['a.com\n`;\n', 'a.com\n${process.exit()}.com\n', 'A.com\n', '# comment\n', 'a.com\n\nb.com\n', 'localhost\n', '', 'a .com\n']) {
		assert.throws(() => parseList(bad), undefined, JSON.stringify(bad));
	}
});

test('sizeChangeProblem allows ±20 % and refuses beyond it', () => {
	assert.equal(sizeChangeProblem(1000, 1200, 0.2), null);
	assert.equal(sizeChangeProblem(1000, 800, 0.2), null);
	assert.match(sizeChangeProblem(1000, 1201, 0.2) ?? '', /1000 to 1201/);
	assert.match(sizeChangeProblem(1000, 799, 0.2) ?? '', /-20\.1 %/);
	assert.equal(sizeChangeProblem(1000, 1500, 0.5), null);
});

test('refresh: already at the commit, nothing written', async () => {
	const { impl } = fakeFetch(OLD, 'never.read\n');
	const r = await refresh({ ts: fileAt(OLD, domains(100)), ref: 'main', maxChange: 0.2, today: '2026-12-01', fetchImpl: impl });
	assert.deepEqual(r, { changed: false, commit: OLD, count: 100 });
});

test('refresh: a new commit within the guard rewrites the file, fetched at that exact commit', async () => {
	const list = [...domains(95), ...domains(10, 'new')];
	const text = `${list.join('\n')}\n`;
	const { impl, urls } = fakeFetch(NEW, text);
	const r = await refresh({ ts: fileAt(OLD, domains(100)), ref: 'main', maxChange: 0.2, today: '2026-12-01', fetchImpl: impl });
	assert.equal(r.changed, true);
	if (!r.changed) return;
	assert.equal(urls[1], `https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/${NEW}/${UPSTREAM_PATH}`);
	const v = readVendored(r.ts);
	assert.deepEqual(v, { commit: NEW, commitDate: '2026-11-30', fetched: '2026-12-01', sha256: createHash('sha256').update(text).digest('hex'), domains: list });
	assert.match(r.body, /100 → 105 \(\+10 \/ -5\), inside the ±20 % size-change guard\./);
	assert.match(r.body, new RegExp(`compare/${OLD}\\.\\.\\.${NEW}`));
});

test('refresh: a size change past the guard is refused, unless --max-change allows it', async () => {
	const { impl } = fakeFetch(NEW, `${domains(130).join('\n')}\n`);
	await assert.rejects(refresh({ ts: fileAt(OLD, domains(100)), ref: 'main', maxChange: 0.2, today: '2026-12-01', fetchImpl: impl }), /100 to 130/);
	const r = await refresh({ ts: fileAt(OLD, domains(100)), ref: 'main', maxChange: 0.3, today: '2026-12-01', fetchImpl: impl });
	assert.equal(r.changed, true);
	if (r.changed) assert.match(r.body, /±30 % size-change guard \(raised from the default/);
});

test('refresh: an API answer without a sha, or a failed download, is refused', async () => {
	const noSha = async () => new Response(JSON.stringify({ commit: {} }));
	await assert.rejects(refresh({ ts: fileAt(OLD, domains(10)), ref: 'main', maxChange: 0.2, today: '2026-12-01', fetchImpl: noSha }), /no commit sha/);
	const gone = async (url) =>
		String(url).startsWith('https://api.github.com/') ? new Response(JSON.stringify({ sha: NEW, commit: { committer: { date: '2026-11-30T00:00:00Z' } } })) : new Response('', { status: 404 });
	await assert.rejects(refresh({ ts: fileAt(OLD, domains(10)), ref: 'main', maxChange: 0.2, today: '2026-12-01', fetchImpl: gone }), /404/);
});

test('parseArgs: defaults, a pinned sha, and refusals', () => {
	assert.deepEqual(parseArgs([]), { ref: 'main', maxChange: 0.2, bodyFile: null });
	assert.deepEqual(parseArgs(['--ref', NEW, '--max-change', '0.35', '--body-file', '/tmp/b.md']), { ref: NEW, maxChange: 0.35, bodyFile: '/tmp/b.md' });
	for (const bad of [['--ref', 'main;rm'], ['--max-change', '0'], ['--max-change', 'x'], ['--nope', '1'], ['--ref']]) assert.ok('error' in parseArgs(bad), bad.join(' '));
});
