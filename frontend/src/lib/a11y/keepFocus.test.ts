// The focus stays on the control pressed (WCAG 2.4.3) on Runs & results and Calibration (a11y hunt, round
// 2026-11-28): a button that disables itself when pressed, or a fold toggle that swaps one button for another,
// throws the keyboard's focus to the page. A source scan, as uiPatterns.test.ts: each rule below found a real case.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', 'components');
const DIRS = ['runs', 'calibration'];
const files = DIRS.flatMap((d) =>
	readdirSync(join(ROOT, d))
		.filter((f) => f.endsWith('.svelte'))
		.map((f) => ({ path: `${d}/${f}`, src: readFileSync(join(ROOT, d, f), 'utf8') }))
);

/** Each `<button …>` opening tag, attributes and all (a `>` inside `{…}` doesn't end it). */
function buttonTags(src: string): string[] {
	const out: string[] = [];
	for (let at = src.indexOf('<button'); at !== -1; at = src.indexOf('<button', at + 1)) {
		let depth = 0;
		let end = at;
		for (; end < src.length; end++) {
			const c = src[end];
			if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '>' && depth === 0) break;
		}
		out.push(src.slice(at, end + 1));
	}
	return out;
}

/** The expression of a `name={…}` attribute (balanced braces), or null. Not aria-disabled for `disabled`. */
function attr(tag: string, name: string): string | null {
	const m = new RegExp(`(?<![\\w-])${name}=\\{`).exec(tag);
	if (!m) return null;
	let depth = 1;
	let i = m.index + m[0].length;
	const start = i;
	for (; i < tag.length && depth > 0; i++) {
		if (tag[i] === '{') depth++;
		else if (tag[i] === '}') depth--;
	}
	return tag.slice(start, i - 1);
}

describe('the focus stays on the control pressed (Runs & results, Calibration)', () => {
	it('the scan reads each button tag whole and tells disabled from aria-disabled', () => {
		const [tag] = buttonTags('<button class="b" disabled={a > b} aria-disabled={c}>x</button>');
		expect(tag).toBe('<button class="b" disabled={a > b} aria-disabled={c}>');
		expect(attr(tag!, 'disabled')).toBe('a > b');
		expect(attr('<button aria-disabled={c}>', 'disabled')).toBeNull();
	});

	it('no button natively disables itself on a state its own click sets (aria-disabled instead)', () => {
		const bad: string[] = [];
		for (const { path, src } of files)
			for (const tag of buttonTags(src)) {
				const disabled = attr(tag, 'disabled');
				const click = attr(tag, 'onclick');
				if (!disabled || !click) continue;
				for (const [, name] of click.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?!=)/g)) if (new RegExp(`\\b${name}\\b`).test(disabled)) bad.push(`${path}: ${tag}`);
			}
		expect(bad).toEqual([]);
	});

	it('Run model, Run forecast and Apply and save the kept fit stay focusable while their action goes', () => {
		const tags = (path: string) => buttonTags(files.find((f) => f.path === path)!.src);
		const run = tags('runs/RunsTab.svelte').filter((t) => /type="submit"|start\(true\)/.test(t) && /run-note/.test(t));
		expect(run).toHaveLength(2);
		for (const t of run) {
			expect(attr(t, 'disabled')).not.toMatch(/runBusy/);
			expect(attr(t, 'aria-disabled')).toMatch(/runBusy/);
		}
		const apply = tags('calibration/AutoFitPanel.svelte').filter((t) => /onclick=\{apply\}/.test(t));
		expect(apply).toHaveLength(1);
		expect(attr(apply[0]!, 'disabled')).not.toMatch(/\bbusy\b/);
		expect(attr(apply[0]!, 'aria-disabled')).toMatch(/\bbusy\b/);
		// The label box beside them is readonly while a run goes, not disabled (it may hold the focus).
		expect(files.find((f) => f.path === 'runs/RunsTab.svelte')!.src).toMatch(/id="run-label"[^>]*readonly=\{runBusy\}/);
	});

	it('a fold toggle is one button whose aria-expanded follows its state, never two swapped in and out', () => {
		const bad = files.flatMap(({ path, src }) => buttonTags(src).filter((t) => /aria-expanded="(true|false)"/.test(t)).map((t) => `${path}: ${t}`));
		expect(bad).toEqual([]);
	});
});
