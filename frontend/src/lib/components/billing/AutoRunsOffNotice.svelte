<script lang="ts">
	// The copy and import dialogs' done state when the API made the new project
	// with automatic runs off at Free's live-catchment limit (`autoRunsOff:
	// "live_catchments"`, liveLimit.ts): one information line saying why, with
	// Compare plans → the Plan page of the account that bills the new project
	// (planLink.ts: its team's, else your own).
	import { basePath } from '#lib/nav/base.js';
	import { AUTO_RUNS_OFF_TEXT } from './liveLimit';
	import { planHref } from './planLink';

	let { teamId }: { teamId: string | null | undefined } = $props();
</script>

<p class="alert alert-info" role="note" data-testid="auto-runs-off">
	{AUTO_RUNS_OFF_TEXT} <a href={planHref(teamId, basePath())}>Compare plans</a>
</p>
