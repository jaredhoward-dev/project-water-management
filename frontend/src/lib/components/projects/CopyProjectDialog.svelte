<script lang="ts">
	// The project list's Copy project dialog (POST /projects/:id/copy; docs/ui.md
	// § The project list). A copy closes the dialog, except when Free's live
	// limit made it with automatic runs off (`autoRunsOff`, 338): then a done
	// state says why, with Compare plans, and opens the copy (AutoRunsOffNotice).
	// The page does the request (`docopy`), so this renders in unit tests without
	// SvelteKit's env, which the app's API reads.
	import { resolve } from '$app/paths';
	import type { CopyResult, ProjectSummary } from '#lib/api/types.js';
	import AutoRunsOffNotice from '#lib/components/billing/AutoRunsOffNotice.svelte';
	import { startedAutoRunsOff } from '#lib/components/billing/liveLimit.js';
	import Dialog from '#lib/components/common/Dialog.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { cleanName, workspaceNameProblem } from '#lib/format/visibleName.js';

	let {
		open = $bindable(false),
		source,
		canAddTo,
		docopy,
		oncopied,
		/** The copy's answer once the done state shows (only when it started with automatic runs off). */
		done = $bindable(null)
	}: {
		open?: boolean;
		source: ProjectSummary | null;
		/** Whether you may add to that team (an editor or above in it): the copy stays there, else it's personal. */
		canAddTo: (teamId: string | undefined) => boolean;
		docopy: (id: string, name: string) => Promise<CopyResult>;
		oncopied?: () => void | Promise<void>;
		done?: CopyResult | null;
	} = $props();

	let name = $state('');
	let error = $state<string | null>(null);
	let copying = $state(false);
	let lastSource: ProjectSummary | null = null;

	// Each opening starts again: the source's name with "(copy)", no error, no done state.
	$effect.pre(() => {
		if (open && source && source !== lastSource) {
			lastSource = source;
			name = `${source.name} (copy)`;
			error = null;
			done = null;
		}
		if (!open) lastSource = null;
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!source) return;
		error = workspaceNameProblem(name, 'project');
		if (error) return;
		copying = true;
		try {
			const r = await docopy(source.id, cleanName(name));
			if (startedAutoRunsOff(r)) done = r;
			else open = false;
			await oncopied?.();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			copying = false;
		}
	}

	const focusOnMount = (el: HTMLElement) => el.focus();
</script>

<Dialog bind:open title={done ? 'Project copied' : 'Copy project'}>
	{#if done}
		<div class="alert alert-info" role="status" data-testid="copy-done">
			Copied to <strong>{done.project.name}</strong>{done.project.team?.name ? ` in ${done.project.team.name}` : ''}.
		</div>
		<AutoRunsOffNotice team={done.project.team} />
	{:else}
		<form id="copy-form" onsubmit={submit}>
			{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
			<p class="muted">
				The model and time series are copied; model runs are not.
				{#if source?.team?.name}
					{canAddTo(source.team.id) ? `The copy stays in ${source.team.name}.` : `You're a viewer in ${source.team.name}, so the copy is personal.`}
				{/if}
			</p>
			<div class="field">
				<span class="label"><label for="cp-name">Name of the copy</label> <HelpTip key="project-copy" label="About copying a project" /></span>
				<input id="cp-name" required maxlength="200" bind:value={name} />
			</div>
		</form>
	{/if}
	{#snippet actions()}
		{#if done}
			<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
			<a class="btn btn-primary" href={resolve(`projects/${done.project.id}`)} {@attach focusOnMount}>Open project</a>
		{:else}
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" form="copy-form" class="btn btn-primary" disabled={copying || !name.trim()}>
				{copying ? 'Copying…' : 'Copy project'}
			</button>
		{/if}
	{/snippet}
</Dialog>
