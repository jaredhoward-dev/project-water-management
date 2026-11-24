<script lang="ts">
	// "Assistant share" inside a team's Plan card (issue #641, docs/ui.md § Plan
	// and usage; PlanUsage.svelte renders it after the subscription lines, and
	// only the team plan route passes it, a page only the team's admins can
	// open): the share of the team's monthly assistant dollars one member may
	// use (default 50%). A NumberInput (whole, 1–100), then the app's confirm
	// dialog with what the share comes to in dollars; POST
	// /teams/:id/plan/assistant-share writes it at once, and the page re-reads
	// the plan. English: the workspace is.
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { provideInvalidFields } from '#lib/components/common/invalidFields.svelte.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import type { AccountPlan } from '#lib/api/types.js';
	import { SHARE_MAX, SHARE_MIN, assistantShareConfirmLine, assistantShareLine, assistantShareState, assistantShareValid } from './assistantShare';

	let {
		plan,
		change,
		reload
	}: {
		plan: AccountPlan;
		/** POST …/plan/assistant-share. */
		change: (pct: number) => Promise<unknown>;
		/** Re-read the plan after the change (the parent updates `plan`). */
		reload?: () => Promise<void>;
	} = $props();

	const st = $derived(assistantShareState(plan));
	const fields = provideInvalidFields();
	// Starts at the share now, then keeps what is typed. The button stays aria-disabled until it differs.
	let value = $state<number | null>(null);
	let filled = false;
	$effect(() => {
		if (!st || filled) return;
		filled = true;
		value = st.current;
	});
	let busy = $state(false);
	let error = $state<string | null>(null);
	let done = $state<number | null>(null);

	const valid = $derived(!!st && fields.count === 0 && assistantShareValid(st, value));

	async function ask() {
		if (!st || busy || !valid || value === null) return;
		const n = value;
		error = null;
		done = null;
		busy = true;
		try {
			const ok = await confirmDialog({
				title: 'Change the assistant share?',
				message: assistantShareConfirmLine(st, n),
				confirmLabel: 'Change share'
			});
			if (!ok) return;
			await change(n);
			done = n;
			if (reload) await reload().catch(() => {});
		} catch (e) {
			error = `Couldn’t change the share: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			busy = false;
		}
	}
</script>

{#if st}
	<section class="assistant-share" data-assistant-share data-share={st.current} aria-labelledby="assistant-share-title">
		<div class="panel-head">
			<h3 id="assistant-share-title">Assistant share</h3>
		</div>
		<div class="row">
			<label for="assistant-share-input">Most one member may use (%)</label>
			<NumberInput
				id="assistant-share-input"
				class="input"
				whole
				min={SHARE_MIN}
				max={SHARE_MAX}
				step={1}
				bind:value
				invalidMessage="Choose a whole percentage from {SHARE_MIN} to {SHARE_MAX}."
				aria-describedby="assistant-share-hint"
				data-assistant-share-input
			/>
			<button type="button" class="btn" aria-disabled={busy || !valid} data-action="change-assistant-share" onclick={ask}>Change share</button>
		</div>
		<p class="muted hint" id="assistant-share-hint" data-assistant-share-line>{assistantShareLine(st)}</p>
		<p class="status" role="status" data-assistant-share-done>{done !== null ? `Saved: one member may now use up to ${done}%.` : ''}</p>
		{#if error}<p class="alert alert-error" role="alert" data-assistant-share-error>{error}</p>{/if}
	</section>
{/if}

<style>
	.assistant-share {
		margin: 0.85rem 0 0;
		padding-top: 0.85rem;
		border-top: 1px solid var(--border);
	}
	.assistant-share .panel-head {
		margin-bottom: 0.5rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.row :global(.input) {
		width: 6rem;
	}
	.hint {
		margin: 0.35rem 0 0;
		font-size: var(--font-sm);
	}
	.status {
		margin: 0.5rem 0 0;
	}
	.status:empty {
		display: none;
	}
	.alert {
		margin: 0.5rem 0 0;
	}
</style>
