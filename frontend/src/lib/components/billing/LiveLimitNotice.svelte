<script lang="ts">
	// Free's one live catchment, refused (liveLimit.ts): #641's words, an
	// information note rather than an error, with Compare plans → the Plan page
	// of the account that bills the catchment (planLink.ts: the team's for a team
	// catchment, from the workspace's context or `teamId`, else your own).
	import { basePath } from '#lib/nav/base.js';
	import { LIVE_LIMIT_TEXT } from './liveLimit';
	import { planHref, useBillingTeam } from './planLink';

	let { teamId }: { teamId?: string | null } = $props();
	const billingTeam = useBillingTeam();
</script>

<div class="alert alert-info" role="status" data-testid="live-limit">
	<p>{LIVE_LIMIT_TEXT}</p>
	<p><a href={planHref(teamId ?? billingTeam(), basePath())}>Compare plans</a></p>
</div>
