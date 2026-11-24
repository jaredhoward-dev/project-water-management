<script lang="ts">
	// "Change seats" inside a team's Plan card (issue #641 Phase 5, docs/ui.md §
	// Plan and usage; PlanUsage.svelte renders it under the subscription's seats
	// line): a live Team subscription's editor seats, from the included ones to
	// 50. A NumberInput (whole), then the app's confirm dialog, which says the
	// new monthly or yearly difference when the plan knows the interval, else
	// the new count, and how many editors would have no seat. POST
	// /teams/:id/plan/seats asks the provider; the seats arrive through its
	// webhook, so the page re-reads the plan on checkout's CONFIRM_DELAYS_MS and
	// says whether they have landed. English: the workspace is.
	import { onDestroy } from 'svelte';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { provideInvalidFields } from '#lib/components/common/invalidFields.svelte.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import type { AccountPlan } from '#lib/api/types.js';
	import { fmtNum } from '#lib/format/number.js';
	import { CONFIRM_DELAYS_MS, editorsHint, type ConfirmState } from './plan';
	import { seatChangeLine, seatChangeNotice, seatChangeState, seatChangeValid } from './seatChange';

	let {
		plan,
		change,
		reload
	}: {
		plan: AccountPlan;
		/** POST …/plan/seats. */
		change: (seats: number) => Promise<unknown>;
		/** Re-read the plan after the change (the parent updates `plan`). */
		reload?: () => Promise<void>;
	} = $props();

	const st = $derived(seatChangeState(plan));
	const editors = $derived(editorsHint(plan.team?.editorCount));
	const fields = provideInvalidFields();
	// Starts at the seats now the first time there is a live subscription (it can arrive after mount, when a
	// checkout's re-read brings it), then keeps what is typed. The button stays aria-disabled until it differs.
	let value = $state<number | null>(null);
	let filled = false;
	$effect(() => {
		if (!st || filled) return;
		filled = true;
		value = st.current;
	});
	let busy = $state(false);
	let error = $state<string | null>(null);
	/** The change asked for, and whether the provider has confirmed it yet. */
	let asked = $state<{ n: number; confirm: ConfirmState } | null>(null);
	let live = true;
	onDestroy(() => (live = false));

	const valid = $derived(!!st && fields.count === 0 && seatChangeValid(st, value));

	async function ask() {
		if (!st || busy || !valid || value === null) return;
		const n = value;
		error = null;
		busy = true;
		try {
			const ok = await confirmDialog({
				title: 'Change editor seats?',
				message: seatChangeLine(st, n, plan.team?.editorCount),
				confirmLabel: 'Change seats'
			});
			if (!ok || !live) return;
			asked = null;
			await change(n);
			value = n;
			asked = { n, confirm: 'waiting' };
			await settle(n);
		} catch (e) {
			error = `Couldn’t change the seats: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			busy = false;
		}
	}

	/** Re-read the plan until it shows `n` seats, as checkout waits for its subscription (PlanUsage.svelte). */
	async function settle(n: number) {
		const landed = () => plan.subscription?.seats === n;
		if (reload) {
			try {
				await reload();
			} catch {
				// The change was taken; a failed re-read is one that hasn't caught up.
			}
			for (const ms of CONFIRM_DELAYS_MS) {
				if (!live || landed()) break;
				await new Promise((r) => setTimeout(r, ms));
				if (!live) return;
				try {
					await reload();
				} catch {
					// As above: try again, then say to reload.
				}
			}
		}
		if (live) asked = { n, confirm: landed() ? 'confirmed' : 'unconfirmed' };
	}
</script>

{#if st}
	<section class="seat-change" data-seat-change aria-labelledby="seat-change-title">
		<div class="panel-head">
			<h3 id="seat-change-title">Change seats</h3>
		</div>
		<div class="row">
			<label for="seat-change-input">Editor seats</label>
			<NumberInput
				id="seat-change-input"
				class="input"
				whole
				min={st.offer.included}
				max={st.offer.max}
				step={1}
				bind:value
				invalidMessage="Choose a whole number of seats from {st.offer.included} to {st.offer.max}."
				aria-describedby={editors ? 'seat-change-editors seat-change-hint' : 'seat-change-hint'}
				data-seat-change-input
			/>
			<button type="button" class="btn" aria-disabled={busy || !valid} data-action="change-seats" onclick={ask}>Change seats</button>
		</div>
		{#if editors}<p class="muted hint" id="seat-change-editors" data-seat-change-editors>{editors}</p>{/if}
		<p class="muted hint" id="seat-change-hint">
			{fmtNum(st.current)} now; from {fmtNum(st.offer.included)} (included) to {fmtNum(st.offer.max)}.
		</p>
		<p class="status" role="status" data-seat-change-done data-confirm={asked?.confirm}>{asked ? seatChangeNotice(asked.n, asked.confirm) : ''}</p>
		{#if error}<p class="alert alert-error" role="alert" data-seat-change-error>{error}</p>{/if}
	</section>
{/if}

<style>
	.seat-change {
		margin: 0.85rem 0 0;
		padding-top: 0.85rem;
		border-top: 1px solid var(--border);
	}
	.seat-change .panel-head {
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
