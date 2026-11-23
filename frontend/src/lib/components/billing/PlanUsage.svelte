<script lang="ts">
	// The Plan and usage page's body (issue #641 Phase 1, docs/ui.md § Plan and
	// usage), shared by /account/plan (your own account) and /teams/[id]/plan
	// (a team's, for its admins): the plan with its price and renewal or trial
	// date, then this month's usage as one bar per counted thing. Usage is
	// counted and, in shadow mode (BILLING_ENFORCED off), nothing is refused.
	// Phase 3: Upgrade (no subscription; each priced from GET /billing/plans) or
	// Manage billing (one) when the billing provider isn't manual; each asks the
	// API for a URL and sends the person there (Stripe's page, or the mock's
	// local one). Team's Upgrade has a seat field (editor seats, from the
	// included ones up), and its buttons price the seats chosen. The workspace is English, so a refusal shows the API's own
	// English message (the billing codes are machine-only); no farmer page shows
	// any of it. The figures and words come from plan.ts.
	import { onMount, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '#lib/api/index.js';
	import type { AccountPlan, BillingInterval, BillingRedirect, PlanOffer } from '#lib/api/types.js';
	import {
		CONFIRM_DELAYS_MS,
		billingActions,
		checkoutNotice,
		monthName,
		parseSeats,
		priceLine,
		seatHint,
		seatOffer,
		shadowNote,
		subscriptionLine,
		upgradeLabel,
		usageRows,
		type ConfirmState
	} from './plan';

	let {
		plan,
		whose,
		checkout,
		portal,
		reload,
		returned = null
	}: {
		plan: AccountPlan;
		whose: 'your account' | 'this team';
		/** Start checkout, with the editor seats chosen when the plan sells extra ones (Team); answers where to go. */
		checkout?: (interval: BillingInterval, seats?: number) => Promise<BillingRedirect>;
		/** Open the billing portal; answers where to go. */
		portal?: () => Promise<BillingRedirect>;
		/** Re-read the plan in place (the parent updates `plan`), while a paid checkout waits for the provider's confirmation. */
		reload?: () => Promise<void>;
		/** `?checkout=` on coming back from checkout; read once, then taken off the address. */
		returned?: string | null;
	} = $props();

	const actions = $derived(billingActions(plan));
	const showUpgrade = $derived(!!(actions.upgrade && checkout));
	const showManage = $derived(!showUpgrade && !!(actions.manage && portal));
	const note = $derived(shadowNote(plan.enforced, showUpgrade || showManage, whose));
	let busy = $state(false);
	let actionError = $state<string | null>(null);

	// The offer being upgraded to, for the buttons' prices; without it they read unpriced.
	let offer = $state<PlanOffer | null>(null);
	let offerAsked = false;
	$effect(() => {
		const code = actions.upgrade?.code;
		if (!code || !showUpgrade || offerAsked) return;
		offerAsked = true;
		api.billing
			.plans()
			.then((plans) => (offer = plans.find((p) => p.code === code) ?? null))
			.catch(() => {});
	});

	// Team's seats: the field's text, the count it reads as (null when out of range), and what the buttons price.
	const seats = $derived(seatOffer(offer));
	let seatsText = $state('');
	$effect(() => {
		if (seats && seatsText === '') seatsText = String(seats.included);
	});
	const seatCount = $derived(seats ? parseSeats(seatsText, seats) : null);
	const seatsInvalid = $derived(!!seats && seatCount === null);

	function upgrade(interval: BillingInterval) {
		if (!checkout) return;
		if (seats) {
			if (seatCount === null) return;
			const n = seatCount;
			void go(() => checkout(interval, n));
		} else void go(() => checkout(interval));
	}

	// The checkout notice lives here, not in the address: it is read once, the
	// live region below exists before its text arrives (so it is announced),
	// and `?checkout=` comes off the address once settled, so a reload or a
	// bookmark doesn't thank anyone twice.
	const firstReturned = untrack(() => returned);
	let shown = $state<string | null>(null);
	let confirm = $state<ConfirmState>('confirmed');
	const notice = $derived(checkoutNotice(shown, confirm));

	onMount(() => {
		if (!firstReturned) return;
		let live = true;
		void (async () => {
			shown = firstReturned;
			if (firstReturned === 'done' && !plan.subscription && reload) {
				confirm = 'waiting';
				for (const ms of CONFIRM_DELAYS_MS) {
					await new Promise((r) => setTimeout(r, ms));
					if (!live) return;
					try {
						await reload();
					} catch {
						// A failed re-read is the same as one that hasn't caught up: try again, then say to reload.
					}
					if (!live) return;
					if (plan.subscription) break;
				}
				confirm = plan.subscription ? 'confirmed' : 'unconfirmed';
			}
			if (!live || !page.url.searchParams.has('checkout')) return;
			const url = new URL(page.url.href);
			url.searchParams.delete('checkout');
			await replaceState(url, page.state);
		})();
		return () => (live = false);
	});

	async function go(start: (() => Promise<BillingRedirect>) | undefined) {
		if (!start || busy) return;
		busy = true;
		actionError = null;
		try {
			const { url } = await start();
			window.location.assign(url);
		} catch (e) {
			actionError = `Couldn’t open billing: ${e instanceof Error ? e.message : String(e)}`;
			busy = false;
		}
	}

	// Back from the provider's page can restore this page from the back-forward
	// cache with `busy` still set from the press that left: free the buttons.
	function onPageShow(e: PageTransitionEvent) {
		if (e.persisted) busy = false;
	}

	const sub = $derived(subscriptionLine(plan.subscription));
	const rows = $derived(usageRows(plan));
	const nothingUsed = $derived(rows.every((r) => r.used === 0));
</script>

<svelte:window onpageshow={onPageShow} />

<div class="plan-usage" data-plan={plan.plan.code} data-enforced={plan.enforced ? 'true' : 'false'}>
	<section class="panel plan-card" aria-labelledby="plan-h" aria-busy={busy}>
		<h2 id="plan-h">Plan</h2>
		<p class="plan-name"><strong data-plan-name>{plan.plan.name}</strong></p>
		<p class="muted price" data-price>{priceLine(plan.plan)}</p>
		{#if sub}
			<p class="sub" class:warn={sub.warn} data-subscription={plan.subscription?.status}>{sub.text}</p>
		{:else}
			<p class="muted sub" data-subscription="none">No subscription: {whose} is on {plan.plan.name}.</p>
		{/if}
		{#if note}
			<p class="note" data-shadow>{note}</p>
		{/if}
		<div role="status" data-checkout-status>
			{#if notice}
				<p class="note" class:done={notice.done} data-checkout-notice={notice.done ? 'done' : 'cancelled'} data-confirm={notice.done ? confirm : undefined}>
					{notice.text}
				</p>
			{/if}
		</div>
		{#if showUpgrade && actions.upgrade && checkout}
			{#if seats}
				<div class="seats" data-seats>
					<label for="checkout-seats">Editor seats</label>
					<input
						id="checkout-seats"
						class="input"
						type="number"
						inputmode="numeric"
						min={seats.included}
						max={seats.max}
						step="1"
						bind:value={() => seatsText, (v) => (seatsText = v === null || v === undefined ? '' : String(v))}
						aria-describedby={seatsInvalid ? 'checkout-seats-hint checkout-seats-error' : 'checkout-seats-hint'}
						aria-invalid={seatsInvalid ? 'true' : undefined}
						data-seats-input
					/>
					<p class="muted seats-hint" id="checkout-seats-hint">{seatHint(seats, offer?.currency ?? 'ZAR')}</p>
					{#if seatsInvalid}
						<p class="err" id="checkout-seats-error" data-seats-error>Choose a whole number of seats from {seats.included} to {seats.max}.</p>
					{/if}
				</div>
			{/if}
			<div class="billing-actions" data-billing-actions>
				<button
					type="button"
					class="btn btn-primary"
					aria-disabled={busy || seatsInvalid}
					data-action="upgrade-month"
					onclick={() => upgrade('month')}>{upgradeLabel(actions.upgrade.name, 'month', offer, seatCount)}</button
				>
				<button type="button" class="btn" aria-disabled={busy || seatsInvalid} data-action="upgrade-year" onclick={() => upgrade('year')}
					>{upgradeLabel(actions.upgrade.name, 'year', offer, seatCount)}</button
				>
			</div>
		{:else if showManage && portal}
			<div class="billing-actions" data-billing-actions>
				<button type="button" class="btn" aria-disabled={busy} data-action="manage-billing" onclick={() => go(portal)}>Manage billing</button>
			</div>
		{/if}
		{#if actionError}<p class="err" role="alert" data-billing-error>{actionError}</p>{/if}
	</section>

	<section class="panel usage-card" aria-labelledby="usage-h">
		<h2 id="usage-h">Usage in {monthName(plan.usage.month)}</h2>
		{#if nothingUsed}
			<p class="muted empty" data-empty>Nothing used yet this month.</p>
		{/if}
		<ul class="rows">
			{#each rows as r (r.key)}
				<li class="row" data-usage={r.key} data-over={r.over ? 'true' : undefined}>
					<div class="row-head">
						<span class="label" id="u-{r.key}">{r.label}</span>
						<span class="figures"
							><span data-figures class:over={r.over && r.status === null}>{r.figures}</span
							>{#if r.status !== null}
								· <span class="status" class:over={r.over} data-status>{r.status}</span>{/if}</span
						>
					</div>
					{#if r.fraction !== null && r.limit !== null}
						<div
							class="bar"
							class:over={r.over}
							role="meter"
							aria-labelledby="u-{r.key}"
							aria-valuemin="0"
							aria-valuemax={r.limit}
							aria-valuenow={Math.min(r.used, r.limit)}
							aria-valuetext={r.status === null ? r.figures : `${r.figures}, ${r.status}`}
						>
							<span style="width: {r.fraction * 100}%"></span>
						</div>
					{/if}
					{#if r.note}<p class="muted row-note">{r.note}</p>{/if}
				</li>
			{/each}
		</ul>
	</section>
</div>

<style>
	/* Two cards side by side where they fit (the plan narrower), stacked on a phone. */
	.plan-usage {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
		gap: 1rem;
		align-items: start;
		max-width: 64rem;
	}
	.panel {
		margin: 0;
		min-width: 0;
	}
	h2 {
		margin: 0 0 0.6rem;
	}
	.plan-name {
		margin: 0;
		font-size: 1.15rem;
	}
	.price,
	.sub {
		margin: 0.25rem 0 0;
	}
	.sub.warn {
		color: var(--warning);
		font-weight: 600;
	}
	.note {
		margin: 0.85rem 0 0;
		padding: 0.5rem 0.65rem;
		border-radius: 6px;
		background: var(--accent-soft);
		font-size: var(--font-sm);
	}
	.note.done {
		background: var(--surface-sunken);
	}
	.billing-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.85rem;
	}
	.seats {
		margin-top: 0.85rem;
		display: grid;
		gap: 0.25rem;
	}
	.seats label {
		font-weight: 600;
	}
	.seats input {
		width: 6rem;
		font-variant-numeric: tabular-nums;
	}
	.seats-hint {
		margin: 0;
		font-size: var(--font-sm);
	}
	.err {
		margin: 0.5rem 0 0;
		color: var(--danger);
	}
	.empty {
		margin: 0 0 0.6rem;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.9rem;
	}
	.row-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25rem 0.75rem;
	}
	.label {
		font-weight: 600;
	}
	.figures {
		font-variant-numeric: tabular-nums;
		color: var(--text-2);
	}
	.status.over,
	[data-figures].over {
		color: var(--warning);
		font-weight: 600;
	}
	.bar {
		margin-top: 0.35rem;
		height: 8px;
		border-radius: 4px;
		background: var(--surface-sunken);
		overflow: hidden;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	/* Over the limit: the warning colour, not only a full bar (WCAG 1.4.1: the words say it too). */
	.bar.over span {
		background: var(--warning);
	}
	.row-note {
		margin: 0.3rem 0 0;
		font-size: var(--font-sm);
	}
</style>
