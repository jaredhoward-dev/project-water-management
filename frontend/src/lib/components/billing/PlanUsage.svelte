<script lang="ts">
	// The Plan and usage page's body (issue #641 Phase 1, docs/ui.md § Plan and
	// usage), shared by /account/plan (your own account) and /teams/[id]/plan
	// (a team's, for its admins): the plan with its price and renewal or trial
	// date, then this month's usage as one bar per counted thing (live
	// catchments among them, 340: plan.ts usageRows). Usage is
	// counted and, in shadow mode (BILLING_ENFORCED off), nothing is refused.
	// Phase 3: Upgrade (no subscription; each priced from GET /billing/plans) or
	// Manage billing (one) when the billing provider isn't manual; each asks the
	// API for a URL and sends the person there (Stripe's page, or the mock's
	// local one). Team's Upgrade has a seat field (editor seats, from the
	// included ones up; a NumberInput, so text it can't take stays with its
	// message), and its buttons price the seats chosen, or show no price while
	// the count is invalid. A team's subscription says its seats. The workspace is English, so a refusal shows the API's own
	// English message (the billing codes are machine-only); no farmer page shows
	// any of it. The figures and words come from plan.ts. Team's seat field starts at
	// the team's editors when they pass the included seats, and says how many there
	// are; a subscription with a recorded interval says what it costs (332).
	// Past Free's live catchments after a plan ended (341), a third card lists
	// them and lets the person choose the one that stays live (KeepLive.svelte, 345).
	import { onMount, untrack, type Snippet } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { PUBLIC_API_URL } from '$app/env/public';
	import { api } from '#lib/api/index.js';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import KeepLive from './KeepLive.svelte';
	import { provideInvalidFields } from '#lib/components/common/invalidFields.svelte.js';
	import type { AccountPlan, BillingInterval, BillingRedirect, LiveCatchments, PlanOffer } from '#lib/api/types.js';
	import {
		CONFIRM_DELAYS_MS,
		billingActions,
		billingRedirect,
		checkoutNotice,
		editorsHint,
		monthName,
		priceLine,
		seatHint,
		seatOffer,
		shadowNote,
		startingSeats,
		subscriptionLine,
		subscriptionSeatsLine,
		subscriptionTotalLine,
		upgradeLabel,
		usageRows,
		wantsKeepPicker,
		type ConfirmState
	} from './plan';

	let {
		plan,
		whose,
		checkout,
		portal,
		reload,
		returned = null,
		seatChange,
		assistantShare,
		liveCatchments,
		keepCatchment
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
		/** Shown under the subscription's seats line (a team's Change seats, SeatChange.svelte; the team plan route passes it). */
		seatChange?: Snippet;
		/** Shown after the subscription lines (a team's Assistant share, AssistantShare.svelte; the team plan route passes it). */
		assistantShare?: Snippet;
		/** GET …/plan/live-catchments, for the picker past Free's live catchments (345). */
		liveCatchments?: () => Promise<LiveCatchments>;
		/** POST …/plan/keep: the catchment that stays live. */
		keepCatchment?: (projectId: string) => Promise<LiveCatchments>;
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

	// Team's seats: the count chosen (once the offer arrives, the larger of the
	// included seats and the team's editors, then only what the person types), whether the field holds text it can't
	// take (its own registry, so it never counts as unsaved work elsewhere), and
	// what the buttons price (null while invalid).
	const seats = $derived(seatOffer(offer));
	const seatFields = provideInvalidFields();
	let seatValue = $state<number | null>(null);
	let seatsFilled = false;
	$effect(() => {
		if (!seats || seatsFilled) return;
		seatsFilled = true;
		seatValue = startingSeats(seats, plan.team?.editorCount);
	});
	const seatsInvalid = $derived(!!seats && (seatFields.count > 0 || seatValue === null));
	const seatCount = $derived(seats && !seatsInvalid ? seatValue : null);

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
			// Only the provider's page leaves the app: Stripe's checkout or billing host on https, or the
			// mock's page on our own API (plan.ts billingRedirect). Anything else is refused with the page's error.
			const target = billingRedirect(url, PUBLIC_API_URL, window.location.href);
			if (!target) throw new Error('the billing provider answered with an address this page won’t open');
			window.location.assign(target);
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
	const seatsLine = $derived(subscriptionSeatsLine(plan));
	const totalLine = $derived(subscriptionTotalLine(plan));
	const editors = $derived(editorsHint(plan.team?.editorCount));
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
			{#if totalLine}<p class="muted sub" data-subscription-total>{totalLine}</p>{/if}
			{#if seatsLine}<p class="muted sub" data-subscription-seats>{seatsLine}</p>{/if}
			{@render seatChange?.()}
		{:else}
			<p class="muted sub" data-subscription="none">No subscription: {whose} is on {plan.plan.name}.</p>
		{/if}
		{@render assistantShare?.()}
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
					<NumberInput
						id="checkout-seats"
						class="input"
						whole
						min={seats.included}
						max={seats.max}
						step={1}
						bind:value={seatValue}
						invalidMessage="Choose a whole number of seats from {seats.included} to {seats.max}."
						aria-describedby={editors ? 'checkout-seats-editors checkout-seats-hint' : 'checkout-seats-hint'}
						data-seats-input
					/>
					{#if editors}<p class="muted seats-hint" id="checkout-seats-editors" data-seats-editors>{editors}</p>{/if}
					<p class="muted seats-hint" id="checkout-seats-hint">{seatHint(seats, offer?.currency ?? 'ZAR')}</p>
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

	{#if liveCatchments && keepCatchment && wantsKeepPicker(plan)}
		<KeepLive {whose} enforced={plan.enforced} load={liveCatchments} keep={keepCatchment} />
	{/if}
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
	/* A priced label ("Upgrade to Team, monthly (R 3 497.00 a month for 5 editor seats)") is wider than a
	   phone: app.css keeps .btn on one line, so here the words wrap inside the button and it never
	   outgrows the card (no sideways scroll at 360 px). */
	.billing-actions .btn {
		white-space: normal;
		max-width: 100%;
		text-align: start;
	}
	.seats {
		margin-top: 0.85rem;
		display: grid;
		gap: 0.25rem;
	}
	.seats label {
		font-weight: 600;
	}
	.seats :global(input) {
		width: 6rem;
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
