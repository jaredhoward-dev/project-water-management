<!--
	The files imported onto the map (issue #326 E5): name, feature count, when
	and by whom, and the file's SHA-256 cut to 12 characters (the full hash is
	the tooltip and what Copy puts on the clipboard), so it no longer wraps on
	a phone. In the upload sheet, and for everyone in Every feature. When the
	clipboard refuses, the full hash takes the short one's place, selected, so
	it can be copied by hand (a tooltip can't be selected, nor seen on touch).
-->
<script lang="ts">
	import type { MapSource } from '#lib/api/index.js';
	import { fmtDate } from '#lib/format/number.js';
	import { tick } from 'svelte';
	import { shortHash } from './mapList';

	let { sources }: { sources: MapSource[] } = $props();

	let copied = $state<string | null>(null);
	let failed = $state<string | null>(null);
	const codes: Record<string, HTMLElement | undefined> = $state({});
	async function copy(s: MapSource) {
		failed = null;
		try {
			await navigator.clipboard.writeText(s.sha256);
			copied = s.id;
		} catch {
			copied = null;
			failed = s.id;
			// The full hash is written out now: select it for the keyboard's or the menu's copy.
			await tick();
			const el = codes[s.id];
			const sel = typeof window !== 'undefined' ? window.getSelection() : null;
			if (el && sel) {
				const range = document.createRange();
				range.selectNodeContents(el);
				sel.removeAllRanges();
				sel.addRange(range);
			}
		}
	}
</script>

<ul class="sources" data-testid="map-sources">
	{#each sources as s (s.id)}
		<li>
			<span><strong>{s.fileName}</strong> · {s.features} feature{s.features === 1 ? '' : 's'} · {fmtDate(s.importedAt, true)}{s.importedBy ? ` by ${s.importedBy}` : ''}</span>
			<span class="hash">
				<span class="small muted">SHA-256</span>
				<code title={s.sha256} data-testid="map-source-hash" bind:this={codes[s.id]}>{failed === s.id ? s.sha256 : `${shortHash(s.sha256)}…`}</code>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => copy(s)}>
					Copy<span class="visually-hidden"> the SHA-256 of {s.fileName}</span>
				</button>
				<span class="small muted" role="status">{copied === s.id ? 'Copied' : failed === s.id ? 'Couldn’t copy automatically. The full hash is selected: copy it with your keyboard or menu.' : ''}</span>
			</span>
		</li>
	{/each}
</ul>

<style>
	.sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	li {
		display: grid;
		gap: 0.15rem;
		overflow-wrap: anywhere;
	}
	.hash {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	code {
		font-size: 0.85rem;
	}
</style>
