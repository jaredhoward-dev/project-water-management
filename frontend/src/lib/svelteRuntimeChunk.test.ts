// Guard: Svelte's runtime ships as one chunk (frontend/vite.config.ts,
// svelteRuntimeChunk; issue #9). Without the rule the bundler cuts the runtime into
// ~15 chunks, several under 0.5 KB, and every page loads more (numbers in
// the bundle budget's history, scripts/guards/bundle-budget/README.md).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config, { helpArticlesChunk, svelteRuntimeChunk } from '../../vite.config';

const SVELTE = '/repo/node_modules/.pnpm/svelte@5.56.10/node_modules/svelte/src';

describe('the Svelte runtime chunk', () => {
	it('puts every client runtime module of Svelte in the one chunk', () => {
		for (const m of ['internal/client/index.js', 'internal/client/dom/blocks/snippet.js', 'internal/disclose-version.js', 'index-client.js', 'store/shared/index.js', 'legacy/legacy-client.js']) {
			expect(svelteRuntimeChunk(`${SVELTE}/${m}`), m).toBe('svelte');
		}
	});

	it('leaves app code, the engine, other packages and the compiler to the bundler', () => {
		for (const id of ['/repo/frontend/src/lib/api/client.ts', '/repo/packages/engine/src/run.ts', '/repo/node_modules/.pnpm/uplot@1.6.32/node_modules/uplot/dist/uPlot.esm.js', `${SVELTE}/compiler/index.js`]) {
			expect(svelteRuntimeChunk(id), id).toBeUndefined();
		}
	});

	it('is the page build’s first code-splitting group (Rolldown’s manualChunks), the help glossary’s data articles the second', () => {
		const output = (config as { build: { rolldownOptions: { output: { codeSplitting: { groups: { name: unknown }[] } } } } }).build.rolldownOptions.output;
		expect(output.codeSplitting.groups).toHaveLength(2);
		expect(output.codeSplitting.groups[0]!.name).toBe(svelteRuntimeChunk);
		expect(output.codeSplitting.groups[1]!.name).toBe(helpArticlesChunk);
	});

	it('puts only the help glossary’s "Input data" articles in their own chunk (issue #66)', () => {
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/articles-data.ts')).toBe('help-articles-data');
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/articles-licensing.ts')).toBe('help-articles-licensing');
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/articles-ewr.ts')).toBe('help-articles-ewr');
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/articles-results.ts')).toBe('help-articles-results');
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/articles-fit.ts')).toBe('help-articles-fit');
		expect(helpArticlesChunk('/repo/frontend/src/lib/help/guides-pages.ts')).toBe('help-guides-pages');
		for (const id of ['/repo/frontend/src/lib/help/articles.ts', '/repo/frontend/src/lib/help/content.ts', '/repo/frontend/src/lib/help/tips.ts', '/repo/frontend/src/lib/help/guides.ts', '/repo/frontend/src/lib/help/guides.test.ts', '/repo/frontend/src/lib/help/articles-data.test.ts', '/repo/frontend/src/lib/components/help/guides-x.ts']) {
			expect(helpArticlesChunk(id), id).toBeUndefined();
		}
	});

	it('gives every guides-<group>.ts and articles-<topic>.ts module in lib/help a chunk of its own, by its name', () => {
		const help = fileURLToPath(new URL('./help/', import.meta.url));
		const modules = readdirSync(help).filter((f) => /^(articles|guides)-.+\.ts$/.test(f) && !f.includes('.test.'));
		// The guides' text (2026-11-25): one module per contents group, so the guides' chunk stays well under the ceiling.
		for (const g of ['start', 'howto', 'use', 'concept', 'pages']) expect(modules).toContain(`guides-${g}.ts`);
		for (const f of modules) expect(helpArticlesChunk(`/repo/frontend/src/lib/help/${f}`), f).toBe(`help-${f.slice(0, -3)}`);
	});
});
