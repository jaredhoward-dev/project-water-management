<script lang="ts">
	// The Demands grid's line naming the run its Supplied and Short columns come from (docs/ui.md § Demands grid).
	import { fmtProjectStamp, runDisplayName } from '#lib/components/project/project.js';
	import { projectTimeZoneReader } from '#lib/components/project/projectClock.js';
	import { ranAgo } from './supplyColour';
	import type { DemandsRun } from './demandsRunLoad.svelte';

	// Run names and dates on the project's clock, as its run report (issue #899).
	const timeZone = projectTimeZoneReader();
	const fmtStamp = (iso: string) => fmtProjectStamp(iso, timeZone());
	const runName = (r: { label?: string | null; createdAt: string }) => runDisplayName(r, timeZone());

	let { run, dirty }: { run: DemandsRun; dirty: boolean } = $props();
</script>

{#if run.meta}
	<p class="small run-caption" data-testid="demands-run" aria-live="polite">
		{#if run.failed}
			Couldn't load run “{runName(run.meta)}”'s results.
			<button type="button" class="btn btn-sm" onclick={() => run.retry()}>Retry</button>
		{:else if run.figures}
			Supplied and Short: the mean a day over run “{runName(run.meta)}”, ran
			{fmtStamp(run.meta.createdAt)} ({ranAgo(run.meta.createdAt)}); – where the run doesn't have the demand.
			{#if dirty}<strong>Unsaved changes aren't in it:</strong> save and run the model to see them.{/if}
		{:else}
			<span class="muted">Loading run “{runName(run.meta)}”'s results…</span>
		{/if}
	</p>
{/if}

<style>
	.run-caption {
		margin: 0 0 0.5rem;
		max-width: 80ch;
	}
</style>
