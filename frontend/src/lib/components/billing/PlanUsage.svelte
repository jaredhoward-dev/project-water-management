<script lang="ts">
	// The Plan and usage page's body (issue #641 Phase 1, docs/ui.md § Plan and
	// usage), shared by /account/plan (your own account) and /teams/[id]/plan
	// (a team's, for its admins): the plan with its price and renewal or trial
	// date, then this month's usage as one bar per counted thing. Phase 1 is
	// shadow mode: usage is counted and nothing is charged or refused, so the
	// page offers no upgrade or checkout, only a line saying so. The workspace
	// is English; no farmer page shows any of it. The figures and words come
	// from plan.ts.
	import type { AccountPlan } from '#lib/api/types.js';
	import { monthName, priceLine, subscriptionLine, usageRows } from './plan';

	let { plan, whose }: { plan: AccountPlan; whose: 'your account' | 'this team' } = $props();

	const sub = $derived(subscriptionLine(plan.subscription));
	const rows = $derived(usageRows(plan));
	const nothingUsed = $derived(rows.every((r) => r.used === 0));
</script>

<div class="plan-usage" data-plan={plan.plan.code} data-enforced={plan.enforced ? 'true' : 'false'}>
	<section class="panel plan-card" aria-labelledby="plan-h">
		<h2 id="plan-h">Plan</h2>
		<p class="plan-name"><strong data-plan-name>{plan.plan.name}</strong></p>
		<p class="muted price" data-price>{priceLine(plan.plan)}</p>
		{#if sub}
			<p class="sub" class:warn={sub.warn} data-subscription={plan.subscription?.status}>{sub.text}</p>
		{:else}
			<p class="muted sub" data-subscription="none">No subscription: {whose} is on {plan.plan.name}.</p>
		{/if}
		{#if !plan.enforced}
			<p class="note" data-shadow>Plans aren’t charged yet. Usage is counted against the plan’s limits so you can see where {whose} stands, but nothing is refused.</p>
		{/if}
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
