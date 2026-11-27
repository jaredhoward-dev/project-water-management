// A guard on the specs, beside snapshotChecks.test.ts: a layout read that races the page.
//
// 1. A one-off scroll. `window.scrollTo(0, scrollHeight)`, `el.scrollTop = …`, `scrollBy(…)` and `mouse.wheel(…)` act
//    once: a page still growing leaves the scroll short of where it was sent, and Chromium animates a wheel scroll past
//    the call's return. A box or scroll position read after it, or a web-first expect that needs the page there (the last
//    section marked at the end), then races the page: scenarios-page.spec.ts read the scenario rail after one scroll to
//    the end while the panels below still grew the page (CI run 46033108045). Scroll with support/scroll.ts
//    (`scrollToEnd`, `scrollToY`, `wheelAndSettle`), which redo the scroll until the page is really there or wait for
//    `scrollend`, or scroll inside an `expect.poll` that checks where it landed. A scroll back to the start (0) can't
//    land short and is fine.
// 2. A box read straight after `setViewportSize`. The browser re-evaluates media queries in its next rendering update,
//    so the read can come from the old width's layout; resize with `resizeTo` (support/reflow.ts), or wait on a web-first
//    expect first.
//
// Where it truly can't race, say why in a `// settled:` comment on the line or the one above. Run by `pnpm test`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SETTLED = /\/\/ settled: \S/;
/** A scroll that acts once. */
const SCROLL = /\b(scrollTo|scrollBy)\(|\.(scrollTop|scrollLeft)\s*=(?!=)|\bmouse\.wheel\(/;
/** …back to the start, which can't land short. */
const TO_START = /\b(scrollTo|scrollBy)\(\s*(0\s*,\s*0|\{\s*top:\s*0\b)|\.(scrollTop|scrollLeft)\s*=\s*0\b/;
/** A read of the layout: a box, a scroll position or size. */
const MEASURE = /boundingBox\(|getBoundingClientRect|scroll(Width|Height|Top|Left|Y|X)\b|client(Width|Height)\b|offset(Width|Height)\b|sidewaysOverflow\(|expectNoSidewaysScroll\(|boxesOf\(/;
/** Inside a poll: the scroll is redone until the condition holds. */
const POLL = /expect\s*\.poll\(|^\s*\.poll\(|\.toPass\(/;

function code(line: string): boolean {
	return line.trim() !== '' && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*');
}

function settled(lines: string[], i: number): boolean {
	return SETTLED.test(lines[i] ?? '') || SETTLED.test(lines[i - 1] ?? '');
}

/** Whether line i sits inside an `expect.poll(…)` or `toPass` opened in the same statement, at most eight lines above. */
function inPoll(lines: string[], i: number): boolean {
	if (POLL.test(lines[i]!)) return true;
	for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
		if (lines[j]!.trimEnd().endsWith(';')) return false;
		if (POLL.test(lines[j]!)) return true;
	}
	return false;
}

/** The `file:line` of every one-off scroll, and every read straight after `setViewportSize`, without a reason. */
export function racingReads(file: string, text: string): string[] {
	const lines = text.split('\n');
	const out: string[] = [];
	lines.forEach((line, i) => {
		if (!code(line) || settled(lines, i)) return;
		if (SCROLL.test(line) && !TO_START.test(line) && !inPoll(lines, i)) {
			out.push(`${file}:${i + 1}`);
			return;
		}
		if (/\.setViewportSize\(/.test(line)) {
			let j = i + 1;
			while (j < lines.length && !code(lines[j]!)) j++;
			const next = lines[j] ?? '';
			if (MEASURE.test(next) && !POLL.test(next) && !settled(lines, j)) out.push(`${file}:${i + 1}`);
		}
	});
	return out;
}

function sources(dir: string): string[] {
	return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
		.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
		.map((f) => join(dir, f));
}

test('the guard flags a one-off scroll and a read straight after a resize, and accepts the settled forms', () => {
	// Flagged: scrolled once to the end, a box read after it; a wheel; a scroll box; a read straight after a resize.
	assert.deepEqual(racingReads('a.ts', '\tawait page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));\n\tconst b = await rail.boundingBox();'), ['a.ts:1']);
	assert.deepEqual(racingReads('a.ts', '\tawait page.mouse.wheel(0, 100);'), ['a.ts:1']);
	// A poll that has closed doesn't cover the scroll after it.
	assert.deepEqual(racingReads('a.ts', '\tawait expect.poll(() => scrollY(page)).toBe(0);\n\tawait page.mouse.wheel(0, -600);'), ['a.ts:2']);
	assert.deepEqual(racingReads('a.ts', '\tawait box.evaluate((el) => (el.scrollTop = el.scrollHeight));'), ['a.ts:1']);
	assert.deepEqual(racingReads('a.ts', '\tawait page.evaluate(() => scrollBy(0, 120));'), ['a.ts:1']);
	assert.deepEqual(racingReads('a.ts', '\tawait page.setViewportSize(PHONE);\n\t// The cards stack.\n\tconst a = (await card.boundingBox())!;'), ['a.ts:1']);
	// Accepted: the helpers, a scroll redone inside a poll, back to the start, a reason, a resize then a web-first expect.
	assert.deepEqual(racingReads('a.ts', '\tawait scrollToEnd(page);\n\tawait wheelAndSettle(page, 0, 100);'), []);
	assert.deepEqual(
		racingReads('a.ts', '\tawait expect\n\t\t.poll(() =>\n\t\t\tpage.evaluate(() => {\n\t\t\t\twindow.scrollTo({ top: document.documentElement.scrollHeight });\n\t\t\t\treturn scrollY;\n\t\t\t})\n\t\t)\n\t\t.toBeGreaterThan(0);'),
		[]
	);
	assert.deepEqual(racingReads('a.ts', '\tawait page.evaluate(() => window.scrollTo(0, 0));\n\tawait box.evaluate((el) => (el.scrollLeft = 0));\n\tawait page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));'), []);
	assert.deepEqual(racingReads('a.ts', '\t// settled: the list is fixed at 40 rows, drawn.\n\tawait box.evaluate((el) => (el.scrollTop = el.scrollHeight));'), []);
	assert.deepEqual(racingReads('a.ts', '\tawait page.setViewportSize(PHONE);\n\tawait expect(menu).toBeVisible();\n\tconst a = (await card.boundingBox())!;'), []);
	assert.deepEqual(racingReads('a.ts', '\tif (a.scrollTop === b) x();'), []);
});

test('no spec or support file reads the layout after a one-off scroll or straight after a resize', () => {
	const found = [...sources('tests'), ...sources('support')].flatMap((f) => racingReads(f, readFileSync(join(root, f), 'utf8')));
	assert.deepEqual(found, [], 'scroll with support/scroll.ts (or inside an expect.poll), resize with resizeTo, or give a `// settled:` reason');
});
