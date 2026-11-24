<script lang="ts">
	// "Live catchments" on the Plan page (341, 345; docs/ui.md § Plan and usage;
	// PlanUsage.svelte renders it when plan.ts wantsKeepPicker): once a plan has
	// ended with the account past Free's live catchments, the list of them,
	// which stays live and which pause (or are paused), and a Keep live button on
	// each other one, asked through the app's confirm dialog. POST …/plan/keep
	// moves the pause at once and answers the new list. An information note in
	// #641's tone, never an error colour. English: the workspace is.
	import { onMount } from 'svelte';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import type { LiveCatchments } from '#lib/api/types.js';
	import { keepPickerIntro, keepQuestion, keepRowState } from './plan';

	let {
		whose,
		enforced,
		load,
		keep
	}: {
		whose: string;
		enforced: boolean;
		/** GET …/plan/live-catchments. */
		load: () => Promise<LiveCatchments>;
		/** POST …/plan/keep; answers the list as it now stands. */
		keep: (projectId: string) => Promise<LiveCatchments>;
	} = $props();

	let list = $state<LiveCatchments | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);

	onMount(() => {
		let live = true;
		load()
			.then((l) => {
				if (live) list = l;
			})
			.catch((e) => {
				if (live) error = `Couldn’t list the live catchments: ${e instanceof Error ? e.message : String(e)}`;
			});
		return () => (live = false);
	});

	const intro = $derived(list ? keepPickerIntro(list, enforced, whose) : null);

	async function choose(id: string, name: string) {
		if (!list || busy) return;
		const current = list.catchments.find((c) => c.staysLive)?.name ?? null;
		error = null;
		done = null;
		busy = true;
		try {
			const ok = await confirmDialog({ title: `Keep ${name} live?`, message: keepQuestion(name, current), confirmLabel: 'Keep live' });
			if (!ok) return;
			list = await keep(id);
			done = `${name} stays live.`;
		} catch (e) {
			error = `Couldn’t change which catchment stays live: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			busy = false;
		}
	}
</script>

{#if (list && intro) || error}
	<section class="panel keep-card" aria-labelledby="keep-h" aria-busy={busy} data-keep-live>
		<h2 id="keep-h">Live catchments</h2>
		{#if list && intro}
			<p class="note" data-keep-intro>{intro}</p>
			<ul class="rows">
				{#each list.catchments as c (c.id)}
					<li class="row" data-keep-row={c.id} data-stays={c.staysLive ? 'true' : 'false'} data-paused={c.pausedAt ? 'true' : undefined}>
						<div class="row-head">
							<span class="label">{c.name}</span>
							<span class="state" data-keep-state>{keepRowState(c, list)}</span>
						</div>
						{#if !c.staysLive}
							<button type="button" class="btn btn-sm" aria-disabled={busy} data-action="keep-live" onclick={() => choose(c.id, c.name)}
								>Keep live<span class="visually-hidden">: {c.name}</span></button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<div role="status" data-keep-status>
			{#if done}<p class="muted done">{done}</p>{/if}
		</div>
		{#if error}<p class="err" role="alert" data-keep-error>{error}</p>{/if}
	</section>
{/if}

<style>
	.panel {
		margin: 0;
		min-width: 0;
	}
	h2 {
		margin: 0 0 0.6rem;
	}
	.note {
		margin: 0 0 0.85rem;
		padding: 0.5rem 0.65rem;
		border-radius: 6px;
		background: var(--accent-soft);
		font-size: var(--font-sm);
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.35rem 0.75rem;
	}
	.row-head {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}
	.label {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.state {
		color: var(--text-2);
		font-size: var(--font-sm);
	}
	.done {
		margin: 0.6rem 0 0;
	}
	.err {
		margin: 0.5rem 0 0;
		color: var(--danger);
	}
</style>
