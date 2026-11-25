<script lang="ts">
	// Free's one live catchment, refused (liveLimit.ts): #641's words, an
	// information note rather than an error, with Compare plans → where
	// planLink.ts says for the account that bills the catchment (the team's
	// plan for a team admin, the price list and "ask a team admin" for anyone
	// else in a team catchment, else your own), from the workspace's context or
	// `team`.
	import { basePath } from '#lib/nav/base.js';
	import { LIVE_LIMIT_TEXT } from './liveLimit';
	import { planLink, useBillingTeam, type BillingTeam } from './planLink';

	let { team }: { team?: BillingTeam | null } = $props();
	const billingTeam = useBillingTeam();
	const link = $derived(planLink(team ?? billingTeam(), basePath()));
</script>

<div class="alert alert-info" role="status" data-testid="live-limit">
	<p>{LIVE_LIMIT_TEXT}</p>
	{#if link.note}<p data-testid="plan-ask-admin">{link.note}</p>{/if}
	<p><a href={link.href}>Compare plans</a></p>
</div>
