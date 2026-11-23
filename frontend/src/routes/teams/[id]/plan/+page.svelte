<script lang="ts">
	// A team's plan and this month's usage, for its admins (issue #641 Phase 1,
	// docs/ui.md § Plan and usage; the body is
	// lib/components/billing/PlanUsage.svelte). The API answers 404 to anyone
	// else, and the page says so the way the team page does for a team you
	// can't see. Linked from the team page's header (admins only).
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, type AccountPlan } from '#lib/api/index.js';
	import { errorText } from '#lib/i18n/apiError.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import PlanUsage from '#lib/components/billing/PlanUsage.svelte';

	const teamId = $derived(page.params.id ?? '');

	let plan = $state<AccountPlan | null>(null);
	/** The team's name for the breadcrumb and title; the page works without it. */
	let teamName = $state<string | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let notFound = $state(false);

	async function load() {
		loading = true;
		loadError = null;
		notFound = false;
		const id = teamId;
		api.teams
			.get(id)
			.then((d) => {
				if (id === teamId) teamName = d.team.name;
			})
			.catch(() => {});
		try {
			const p = await api.teams.plan(id);
			if (id === teamId) plan = p;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else loadError = `Couldn’t look up this team’s plan: ${errorText(e)}`;
		} finally {
			loading = false;
		}
	}
	/** Re-read the plan in place, without the loading state (which would remount the body and lose its checkout notice). */
	async function reload() {
		const id = teamId;
		const p = await api.teams.plan(id);
		if (id === teamId) plan = p;
	}
	$effect(() => {
		void teamId;
		untrack(() => {
			plan = null;
			teamName = null;
			void load();
		});
	});
</script>

<svelte:head><title>{teamName ? `${teamName} · ` : ''}Plan and usage · IC-WBT</title></svelte:head>

<main class="page plan-page" data-ready={!loading ? 'true' : undefined}>
	<LoadState {loading} error={loadError} retry={load}>
		{#if notFound || !plan}
			<div class="alert alert-error" role="alert" data-not-found>
				This team doesn't exist or you're not one of its admins. <a href={resolve('teams')}>Back to teams</a>
			</div>
		{:else}
			<nav class="crumbs" aria-label="Breadcrumb">
				<a href={resolve('teams')}>Teams</a> <span aria-hidden="true">/</span>
				<a href={resolve(`teams/${teamId}`)}>{teamName ?? 'Team'}</a> <span aria-hidden="true">/</span>
			</nav>
			<header class="page-head">
				<h1>Plan and usage</h1>
				<p class="muted">The team’s plan, and what its projects have used this month.</p>
			</header>
			<PlanUsage
				{plan}
				whose="this team"
				checkout={(interval) => api.teams.checkout(teamId, interval)}
				portal={() => api.teams.portal(teamId)}
				{reload}
				returned={page.url.searchParams.get('checkout')}
			/>
		{/if}
	</LoadState>
</main>

<style>
	.plan-page {
		max-width: 92rem;
		padding-bottom: 1.5rem;
	}
	.crumbs {
		font-size: var(--font-sm);
		margin-bottom: 0.35rem;
	}
	.page-head {
		margin-bottom: 1rem;
	}
	.page-head h1 {
		margin: 0;
	}
	.page-head p {
		margin: 0.25rem 0 0;
	}
</style>
