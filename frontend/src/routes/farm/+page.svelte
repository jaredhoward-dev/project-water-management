<!-- i18n-section: farm -->
<script lang="ts">
	// "Your farms" (docs/design/farmer-view.md §6.5 board 9): every farm linked
	// to this user, across projects, with its notice level, received % and dam
	// %, the worst notice first. A farmer with one farm goes straight to its page. The root page sends
	// a user whose every membership is `farmer` here.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { basePath } from '#lib/nav/base.js';
	import type { FarmIndex, FarmView } from '@water-management/engine';
	import { api } from '#lib/api/index.js';
	import { session } from '#lib/auth/session.svelte.js';
	import FarmShell from '#lib/components/farm/FarmShell.svelte';
	import FarmNoticeGate from '#lib/components/farm/FarmNoticeGate.svelte';
	import FarmSkeleton from '#lib/components/farm/FarmSkeleton.svelte';
	import FarmStatus from '#lib/components/farm/FarmStatus.svelte';
	import { farmSummaryLine, farmsPrivacy, levelWord, savedStrip, stateText } from '#lib/components/farm/cards.js';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { ApiError } from '#lib/api/client.js';
	import { errorText } from '#lib/i18n/apiError.js';
	import { cardOnFailure, classify, farmHref, worstFirst } from '#lib/components/farm/load.js';
	import { clearSaved, readSaved } from '#lib/components/farm/savedCopy.js';

	interface Row {
		projectId: string;
		projectName: string;
		nodeId: string;
		name: string;
		several: boolean;
		publication: FarmIndex['publication'];
		view: FarmView | null;
		/** Neither the live figures nor a saved copy could be had: the card says so rather than show a blank line. */
		viewFailed: boolean;
		/** The figures are withheld from this viewer (403 farm_preview_withheld): the card says why, never the saved copy (#875). */
		withheld: boolean;
		/** The figures are this phone's saved copy, fetched then (ms), since the live ones failed: the card says so, never as current. */
		savedAt: number | null;
	}

	let rows = $state<Row[] | null>(null);
	let hasOther = $state(false);
	let failed = $state<{ offline: boolean; attempts: number } | null>(null);
	/** Failed loads in a row: the error state adds a contact line after the second. */
	let failures = 0;
	/** Bumped by each load, so a slower earlier load's figures never land on the newer list. */
	let generation = 0;

	async function load() {
		const gen = ++generation;
		failed = null;
		rows = null;
		try {
			const projects = await api.projects.list();
			const mine = projects.filter((p) => p.role === 'farmer');
			hasOther = projects.length > mine.length;
			const indexes = await Promise.allSettled(mine.map((p) => api.farm.index(p.id)));
			// A project the farmer just lost (403/404) is left out; any other failure
			// with nothing to show is the error state, not "no farm linked".
			const failure = indexes.find((r) => r.status === 'rejected' && classify(r.reason) !== 'removed');
			const list: Row[] = [];
			indexes.forEach((r, i) => {
				if (r.status !== 'fulfilled') return;
				const ix = r.value;
				for (const f of ix.farms) {
					list.push({
						projectId: mine[i]!.id,
						projectName: ix.project.name,
						nodeId: f.nodeId,
						name: f.name,
						several: ix.farms.length > 1,
						publication: ix.publication,
						view: null,
						viewFailed: false,
						withheld: false,
						savedAt: null
					});
				}
			});
			if (!list.length && failure) throw (failure as PromiseRejectedResult).reason;
			if (list.length === 1) {
				await goto(farmHref(basePath(), list[0]!.projectId, list[0]!.nodeId, false), { replace: true });
				return;
			}
			failures = 0;
			// The worst notice first (a restriction before an advisory, before none, before
			// unpublished), each level in the projects' order: a restricted farm is never a screen down.
			const ordered = worstFirst(list);
			rows = ordered;
			// The figures on each card: live when published, else the phone's saved copy; a farm
			// unlinked since the list loaded (403/404) leaves the list, its copy with it (cardOnFailure).
			const user = session.user?.id ?? null;
			await Promise.all(
				ordered.map(async (row) => {
					if (!row.publication) return;
					let view: FarmView | null;
					let withheld = false;
					let savedAt: number | null = null;
					try {
						view = await api.farm.view(row.projectId, row.nodeId);
					} catch (e) {
						const next = cardOnFailure(e, () => (user ? readSaved(user, row.projectId, row.nodeId) : null));
						if (next.drop) {
							clearSaved(row.projectId, row.nodeId);
							if (gen === generation && rows) rows = rows.filter((r) => r.projectId !== row.projectId || r.nodeId !== row.nodeId);
							return;
						}
						view = next.view?.view ?? null;
						savedAt = next.view?.savedAt ?? null;
						withheld = next.withheld;
					}
					// A reload since (Try again, a new list) owns the cards now.
					if (gen !== generation || !rows) return;
					const live = rows.find((r) => r.projectId === row.projectId && r.nodeId === row.nodeId);
					if (!live) return;
					live.view = view;
					live.withheld = withheld;
					live.savedAt = savedAt;
					live.viewFailed = view == null && !withheld;
				})
			);
		} catch (e) {
			failed = { offline: classify(e) === 'offline', attempts: ++failures };
		}
	}
	onMount(load);
</script>

<svelte:head><title>{t('{page} · My hydrological unit', { page: t('Your hydrological units') })}</title></svelte:head>

<FarmShell title={t('My hydrological units')} busy={rows == null && !failed}>
	{#if failed}
		<FarmStatus kind="error" offline={failed.offline} attempts={failed.attempts} retry={load} />
	{:else if rows == null}
		<FarmSkeleton />
	{:else if rows.length === 0}
		<h1>{t('Your hydrological units')}</h1>
		<p>{t('No hydrological unit is linked to your account yet. Your WUA links your hydrological unit to your account.')}</p>
		{#if hasOther}<a class="link" href={resolve('')}>{t('Your projects')}</a>{/if}
	{:else}
		<!-- "Before you look at your farm" first, until acknowledged: this list carries figures too. -->
		<FarmNoticeGate>
			<h1>{t('Your hydrological units')}</h1>
			<ul class="farms">
				{#each rows as r (r.projectId + '/' + r.nodeId)}
					<li>
						<a href={farmHref(basePath(), r.projectId, r.nodeId, r.several)}>
							<span class="top">
								<strong>{r.name}</strong>
								{#if r.publication}<span class="level {r.publication.restriction.level}">{levelWord(r.publication.restriction.level)}</span>{/if}
							</span>
							<span class="sub">{r.projectName}</span>
							<!-- While the figures load, "Updating…"; if they can't be had (no signal, no saved copy), the page's own error title, never a blank line;
							     withheld from this viewer, why, worded from the API's code as the farm page words it (#875). -->
							<span class:pending={r.publication && !r.view}
								>{r.publication
									? r.view
										? farmSummaryLine(r.view.farm)
										: r.withheld
											? errorText(new ApiError(403, '', undefined, 'farm_preview_withheld'))
											: r.viewFailed
												? stateText('errorTitle')
												: stateText('updating')
									: t('Not published yet')}</span
							>
							<!-- The live figures failed and these are the phone's saved copy: said so, with when it was saved, as the farm page's strip does. -->
							{#if r.view && r.savedAt != null}<span class="saved" data-testid="farm-card-saved">{savedStrip(r.savedAt, 'failed')}</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
			<p class="fine">{farmsPrivacy()}</p>
		</FarmNoticeGate>
	{/if}
</FarmShell>

<style>
	.farms {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.farms a {
		min-height: var(--tap);
		padding: 16px;
		border-radius: 8px;
		background: var(--surface);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: var(--text);
		text-decoration: none;
	}
	.farms a:hover {
		border-color: var(--accent);
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 17px;
	}
	.pending {
		color: var(--text-2);
	}
	.saved {
		font-size: 14px;
		color: var(--warning);
	}
	.level {
		padding: 2px 10px;
		border-radius: 999px;
		font-size: 14px;
		font-weight: 600;
		border: 1px solid;
	}
	.level.advisory {
		color: var(--warning);
		background: var(--warning-soft);
	}
	.level.restricted {
		color: var(--danger);
		background: var(--danger-soft);
	}
	.level.none {
		color: var(--success);
		background: var(--success-soft);
	}
</style>
