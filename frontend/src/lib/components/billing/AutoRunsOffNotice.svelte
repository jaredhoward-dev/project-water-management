<script lang="ts">
	// The copy and import dialogs' done state when the API made the new project
	// with automatic runs off at Free's live-catchment limit (`autoRunsOff:
	// "live_catchments"`, liveLimit.ts): one information line saying why, with
	// Compare plans → where planLink.ts says for the account that bills the new
	// project (a team admin: the team's plan; anyone else in a team catchment:
	// the price list and "ask a team admin"; else your own).
	import { basePath } from '#lib/nav/base.js';
	import { AUTO_RUNS_OFF_TEXT } from './liveLimit';
	import { planLink, type BillingTeam } from './planLink';

	let { team }: { team: BillingTeam | null | undefined } = $props();
	const link = $derived(planLink(team, basePath()));
</script>

<p class="alert alert-info" role="note" data-testid="auto-runs-off">
	{AUTO_RUNS_OFF_TEXT}{#if link.note} <span data-testid="plan-ask-admin">{link.note}</span>{/if} <a href={link.href}>Compare plans</a>
</p>
