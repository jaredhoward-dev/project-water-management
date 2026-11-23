<script lang="ts">
	// Your account's plan and this month's usage (issue #641 Phase 1, docs/ui.md
	// § Plan and usage; the body is lib/components/billing/PlanUsage.svelte).
	// English: the workspace's page, linked from the account page. Plan data
	// never reaches a farmer page, so a farmer-only user (whose account pages
	// sit in the farm frame) is sent back to the account page before anything
	// is read.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, type AccountPlan } from '#lib/api/index.js';
	import { farmFrameReader } from '#lib/auth/frame.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import PlanUsage from '#lib/components/billing/PlanUsage.svelte';
	import SectionHeader from '#lib/components/workspace/SectionHeader.svelte';

	const inFarmFrame = farmFrameReader();

	let plan = $state<AccountPlan | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		try {
			plan = await api.billing.mine();
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		if (inFarmFrame()) void goto(resolve('account'), { replace: true });
		else void load();
	});
</script>

<svelte:head><title>Plan and usage · IC-WBT</title></svelte:head>

<main class="page plan-page" data-ready={!loading ? 'true' : undefined}>
	<SectionHeader title="Plan and usage">
		{#snippet context()}
			<span>Your own account’s plan, and what it has used this month. A team’s plan is on its team page.</span>
		{/snippet}
		{#snippet actions()}
			<a class="btn" href={resolve('account')}>Back to your account</a>
		{/snippet}
	</SectionHeader>
	{#if !inFarmFrame()}
		<LoadState {loading} error={loadError} retry={load}>
			{#if plan}<PlanUsage {plan} whose="your account" />{/if}
		</LoadState>
	{/if}
</main>

<style>
	.plan-page {
		max-width: 92rem;
		padding-bottom: 1.5rem;
	}
</style>
