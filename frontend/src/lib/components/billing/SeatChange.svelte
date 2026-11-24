<script lang="ts">
	// "Change seats" on a team's plan page (issue #641 Phase 5, docs/ui.md §
	// Plan and usage): a live Team subscription's editor seats, from the
	// included ones to 50. A NumberInput (whole), then a confirm step that says
	// the new monthly or yearly difference when the plan knows the interval, else
	// the new count. POST /teams/:id/plan/seats asks the provider; the seats
	// arrive through its webhook, so the page re-reads the plan and says whether
	// they have landed yet. English: the workspace is.
	import { untrack } from 'svelte';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { provideInvalidFields } from '#lib/components/common/invalidFields.svelte.js';
	import type { AccountPlan } from '#lib/api/types.js';
	import { fmtNum } from '#lib/format/number.js';
	import { seatChangeLine, seatChangeState, seatChangeValid } from './seatChange';

	let {
		plan,
		change,
		reload
	}: {
		plan: AccountPlan;
		/** POST …/plan/seats. */
		change: (seats: number) => Promise<unknown>;
		/** Re-read the plan after the change. */
		reload?: () => Promise<void>;
	} = $props();

	const st = $derived(seatChangeState(plan));
	const fields = provideInvalidFields();
	// Starts at the seats now (the button stays aria-disabled until it differs), then keeps what is typed.
	let value = $state<number | null>(untrack(() => seatChangeState(plan)?.current ?? null));
	let confirming = $state<number | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);

	const valid = $derived(!!st && fields.count === 0 && seatChangeValid(st, value));

	function ask() {
		if (!st || busy || !valid || value === null) return;
		error = null;
		done = null;
		confirming = value;
	}

	async function confirm() {
		if (busy || confirming === null) return;
		const n = confirming;
		busy = true;
		error = null;
		try {
			await change(n);
			confirming = null;
			value = n;
			try {
				await reload?.();
			} catch {
				// The change was taken; a failed re-read only means the page shows the old count until reloaded.
			}
			done =
				plan.subscription?.seats === n
					? `The team now has ${fmtNum(n)} editor seats.`
					: `Asked for ${fmtNum(n)} editor seats. The page shows them once the payment provider confirms; reload in a minute.`;
		} catch (e) {
			error = `Couldn’t change the seats: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			busy = false;
		}
	}
</script>

{#if st}
	<section class="panel seat-change" data-seat-change aria-labelledby="seat-change-title">
		<h2 id="seat-change-title">Change seats</h2>
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
				aria-describedby="seat-change-hint"
				data-seat-change-input
			/>
			<button type="button" class="btn" aria-disabled={busy || !valid || confirming !== null} data-action="change-seats" onclick={ask}>Change seats</button>
		</div>
		<p class="muted hint" id="seat-change-hint">
			{fmtNum(st.current)} now; from {fmtNum(st.offer.included)} (included) to {fmtNum(st.offer.max)}.
		</p>
		{#if confirming !== null}
			<div class="confirm" data-seat-change-confirm>
				<p>{seatChangeLine(st, confirming)}</p>
				<button type="button" class="btn btn-primary" aria-disabled={busy} data-action="confirm-seats" onclick={confirm}>Confirm the change</button>
				<button type="button" class="btn" aria-disabled={busy} data-action="cancel-seats" onclick={() => !busy && (confirming = null)}>Cancel</button>
			</div>
		{/if}
		<p class="status" role="status" data-seat-change-done>{done ?? ''}</p>
		{#if error}<p class="alert alert-error" role="alert" data-seat-change-error>{error}</p>{/if}
	</section>
{/if}

<style>
	.seat-change {
		margin: 1rem 0 0;
		max-width: 64rem;
	}
	.seat-change h2 {
		margin: 0 0 0.6rem;
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
	.confirm {
		margin-top: 0.75rem;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.confirm p {
		flex-basis: 100%;
		margin: 0;
	}
	.status:empty {
		display: none;
	}
</style>
