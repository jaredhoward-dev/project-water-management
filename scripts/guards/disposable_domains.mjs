#!/usr/bin/env node
// The vendored disposable-email domain list: refreshing it from upstream.
//
// backend/src/auth/disposableDomains.ts holds the CC0 disposable-email-domains
// list (issue #641 § Free tier and abuse, item 5; docs/data-sources.md §
// disposable-email-domains), never fetched at runtime. #641 asks for it
// "refreshed monthly with a size-change guard". So:
//
//   refresh  reads upstream's commit for --ref (default `main`; a 40-hex sha
//            pins one) from the GitHub API, fetches
//            disposable_email_blocklist.conf at that exact commit, checks
//            every line is a lower-case domain (the list lands inside a
//            TypeScript template literal, so a backtick or `${` must never
//            reach it), refuses a change in the number of domains beyond
//            --max-change (default 0.2, ±20 %) against the vendored copy,
//            and rewrites the file with a new header (commit, its date, the
//            fetch date, the count, the upstream file's SHA-256). Already at
//            that commit: nothing is written. Writes changed, commit,
//            old_count and new_count to $GITHUB_OUTPUT when set, and with
//            --body-file the pull request's text.
//            Exit 0 written or unchanged; 1 refused (size, format, fetch);
//            2 bad arguments.
//
// Network: two HTTPS GETs per run (api.github.com, raw.githubusercontent.com),
// no token, a descriptive User-Agent. The monthly workflow
// .github/workflows/disposable-domains.yml runs it and opens a pull request.
//
// Run:   pnpm gen:disposable-domains [--ref <sha|branch>] [--max-change 0.2]
// CI:    .github/workflows/disposable-domains.yml (monthly, and by hand)
// Tests: node --test scripts/guards/disposable_domains.test.mjs

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FILE = 'backend/src/auth/disposableDomains.ts';
export const UPSTREAM_REPO = 'disposable-email-domains/disposable-email-domains';
export const UPSTREAM_PATH = 'disposable_email_blocklist.conf';
export const DEFAULT_MAX_CHANGE = 0.2;
const USER_AGENT = 'water-management-disposable-domains-refresh/1 (monthly, two requests)';

const SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9._/-]{1,100}$/;
// A lower-case domain of two or more labels, as upstream ships them.
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LITERAL = /export const DISPOSABLE_DOMAINS_TEXT = `\n([\s\S]*?)`;\s*$/;

/**
 * The vendored file's header fields (null when unreadable) and domains.
 * @param {string} ts the TypeScript file
 * @returns {{ commit: string | null, commitDate: string | null, fetched: string | null, sha256: string | null, domains: string[] }}
 */
export function readVendored(ts) {
	const m = ts.match(LITERAL);
	if (!m) throw new Error(`${FILE}: no DISPOSABLE_DOMAINS_TEXT template literal`);
	const head = ts.match(/at commit\n\/\/\s+([0-9a-f]{40}) \((\d{4}-\d{2}-\d{2})\)/);
	return {
		commit: head?.[1] ?? null,
		commitDate: head?.[2] ?? null,
		fetched: ts.match(/^\/\/ Fetched: (\d{4}-\d{2}-\d{2})\./m)?.[1] ?? null,
		sha256: ts.match(/upstream file\n\/\/\s+([0-9a-f]{64})\./)?.[1] ?? null,
		domains: m[1].split('\n').filter((l) => l !== '')
	};
}

/**
 * Upstream's file as a list of domains; throws on any line that isn't a
 * lower-case domain (comments and blank lines included: upstream has none).
 * @param {string} text
 * @returns {string[]}
 */
export function parseList(text) {
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	if (lines.length === 0) throw new Error('the upstream list is empty');
	lines.forEach((l, i) => {
		if (!DOMAIN.test(l)) throw new Error(`upstream line ${i + 1} is not a lower-case domain: ${JSON.stringify(l.slice(0, 80))}`);
	});
	return lines;
}

/**
 * Why the size change is refused, or null when it is within ±maxChange.
 * @param {number} oldCount
 * @param {number} newCount
 * @param {number} maxChange a share, 0.2 for ±20 %
 */
export function sizeChangeProblem(oldCount, newCount, maxChange) {
	if (oldCount <= 0) return null;
	const change = (newCount - oldCount) / oldCount;
	if (Math.abs(change) <= maxChange) return null;
	return `the list would go from ${oldCount} to ${newCount} domains (${(change * 100).toFixed(1)} %), beyond ±${(maxChange * 100).toFixed(0)} %; read upstream's history, then rerun with --max-change if it is real`;
}

/**
 * The whole vendored file.
 * @param {{ commit: string, commitDate: string, fetched: string, domains: string[], sha256: string }} v
 */
export function render({ commit, commitDate, fetched, domains, sha256 }) {
	return `// The disposable-email domain blocklist, vendored (issue #641 § Free tier and
// abuse, anti-abuse item 5; docs/data-sources.md § disposable-email-domains).
//
// Source:  https://github.com/${UPSTREAM_REPO}
//          ${UPSTREAM_PATH} at commit
//          ${commit} (${commitDate})
// Licence: CC0 1.0 Universal (public domain dedication), so no attribution is
//          owed; we name the source anyway.
// Fetched: ${fetched}. ${domains.length} domains, sha256 of the upstream file
//          ${sha256}.
//
// Never fetched at runtime (local-first). Generated: \`pnpm
// gen:disposable-domains\` (scripts/guards/disposable_domains.mjs) rewrites
// it, refusing a size change beyond ±20 %; the monthly workflow
// .github/workflows/disposable-domains.yml opens the pull request. One
// lower-case domain a line, as upstream ships it. Read only by disposable.ts.
export const DISPOSABLE_DOMAINS_TEXT = \`
${domains.join('\n')}
\`;
`;
}

/**
 * The pull request's text.
 * @param {{ oldCommit: string | null, commit: string, commitDate: string, oldCount: number, newCount: number, added: number, removed: number, maxChange: number }} v
 */
export function prBody({ oldCommit, commit, commitDate, oldCount, newCount, added, removed, maxChange }) {
	const compare = oldCommit ? `https://github.com/${UPSTREAM_REPO}/compare/${oldCommit}...${commit}` : `https://github.com/${UPSTREAM_REPO}/commits/${commit}`;
	return `Monthly refresh of the vendored disposable-email domain list (\`${FILE}\`), issue #641.

- Upstream: \`${UPSTREAM_REPO}\` at \`${commit}\` (${commitDate}); changes: ${compare}
- Domains: ${oldCount} → ${newCount} (+${added} / -${removed}), inside the ±${(maxChange * 100).toFixed(0)} % size-change guard${maxChange === DEFAULT_MAX_CHANGE ? '' : ' (raised from the default ±20 % for this run: say why in review)'}.
- Licence: CC0 1.0 (unchanged; check upstream's \`LICENSE.txt\` if its history touched it).

Opened by \`.github/workflows/disposable-domains.yml\` (\`pnpm gen:disposable-domains\`). Before merging: skim the diff for a common provider added by mistake (gmail.com, outlook.com, a South African ISP); \`backend/src/auth/disposable.test.ts\` checks the format, a size range and the positive controls.
`;
}

/**
 * Upstream's commit for a ref and the file at that commit.
 * @param {string} ref
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ commit: string, commitDate: string, text: string }>}
 */
export async function fetchUpstream(ref, fetchImpl = fetch) {
	const headers = { 'user-agent': USER_AGENT };
	const c = await fetchImpl(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/${encodeURIComponent(ref)}`, {
		headers: { ...headers, accept: 'application/vnd.github+json' },
		redirect: 'error'
	});
	if (!c.ok) throw new Error(`GitHub API: ${c.status} for ${UPSTREAM_REPO}@${ref}`);
	const meta = /** @type {{ sha?: unknown, commit?: { committer?: { date?: unknown } } }} */ (await c.json());
	const commit = typeof meta.sha === 'string' && SHA.test(meta.sha) ? meta.sha : null;
	const date = meta.commit?.committer?.date;
	if (!commit || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(date)) throw new Error('GitHub API: no commit sha or date in the answer');
	const f = await fetchImpl(`https://raw.githubusercontent.com/${UPSTREAM_REPO}/${commit}/${UPSTREAM_PATH}`, { headers, redirect: 'error' });
	if (!f.ok) throw new Error(`raw.githubusercontent.com: ${f.status} for ${UPSTREAM_PATH} at ${commit}`);
	return { commit, commitDate: date.slice(0, 10), text: await f.text() };
}

/**
 * One refresh against the vendored text. Pure but for fetchImpl.
 * @param {{ ts: string, ref: string, maxChange: number, today: string, fetchImpl?: typeof fetch }} o
 * @returns {Promise<{ changed: false, commit: string, count: number } | { changed: true, ts: string, body: string, commit: string, oldCount: number, newCount: number }>}
 */
export async function refresh({ ts, ref, maxChange, today, fetchImpl }) {
	const old = readVendored(ts);
	const up = await fetchUpstream(ref, fetchImpl);
	if (up.commit === old.commit) return { changed: false, commit: up.commit, count: old.domains.length };
	const domains = parseList(up.text);
	const problem = sizeChangeProblem(old.domains.length, domains.length, maxChange);
	if (problem) throw new Error(problem);
	const before = new Set(old.domains);
	const after = new Set(domains);
	const added = domains.filter((d) => !before.has(d)).length;
	const removed = old.domains.filter((d) => !after.has(d)).length;
	const sha256 = createHash('sha256').update(up.text).digest('hex');
	return {
		changed: true,
		commit: up.commit,
		oldCount: old.domains.length,
		newCount: domains.length,
		ts: render({ commit: up.commit, commitDate: up.commitDate, fetched: today, domains, sha256 }),
		body: prBody({ oldCommit: old.commit, commit: up.commit, commitDate: up.commitDate, oldCount: old.domains.length, newCount: domains.length, added, removed, maxChange })
	};
}

/**
 * @param {string[]} argv
 * @returns {{ ref: string, maxChange: number, bodyFile: string | null } | { error: string }}
 */
export function parseArgs(argv) {
	const out = { ref: 'main', maxChange: DEFAULT_MAX_CHANGE, bodyFile: /** @type {string | null} */ (null) };
	for (let i = 0; i < argv.length; i++) {
		const [flag, value] = [argv[i], argv[i + 1]];
		if (flag === '--ref' && value !== undefined) {
			if (!SHA.test(value) && !REF.test(value)) return { error: `--ref: not a branch, tag or sha: ${value}` };
			out.ref = value;
		} else if (flag === '--max-change' && value !== undefined) {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0 || n >= 10) return { error: `--max-change: a share above 0 (0.2 is ±20 %): ${value}` };
			out.maxChange = n;
		} else if (flag === '--body-file' && value !== undefined) {
			out.bodyFile = value;
		} else return { error: `unknown or incomplete argument: ${flag}` };
		i++;
	}
	return out;
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);
	if (cmd !== 'refresh' || 'error' in args) {
		console.error(`usage: disposable_domains.mjs refresh [--ref <sha|branch>] [--max-change 0.2] [--body-file <file>]${'error' in args ? `\n${args.error}` : ''}`);
		process.exit(2);
	}
	const output = (/** @type {Record<string, string | number | boolean>} */ kv) => {
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(kv).map(([k, v]) => `${k}=${v}\n`).join(''));
	};
	try {
		const r = await refresh({ ts: readFileSync(FILE, 'utf8'), ref: args.ref, maxChange: args.maxChange, today: new Date().toISOString().slice(0, 10) });
		if (!r.changed) {
			console.log(`${FILE} is already at ${r.commit} (${r.count} domains); nothing written.`);
			output({ changed: false, commit: r.commit });
			return;
		}
		writeFileSync(FILE, r.ts);
		if (args.bodyFile) writeFileSync(args.bodyFile, r.body);
		console.log(`${FILE}: ${r.oldCount} → ${r.newCount} domains at ${r.commit}.`);
		output({ changed: true, commit: r.commit, old_count: r.oldCount, new_count: r.newCount });
	} catch (err) {
		console.error(`::error::disposable domains refresh refused: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
