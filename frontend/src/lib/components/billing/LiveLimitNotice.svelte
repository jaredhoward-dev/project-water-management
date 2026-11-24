<script lang="ts">
	// Free's one live catchment, refused (liveLimit.ts): #641's words, an
	// information note rather than an error, with Compare plans → the Plan page.
	import { resolve } from '$app/paths';
	import { LIVE_LIMIT_TEXT } from './liveLimit';
</script>

<div class="alert alert-info" role="status" data-testid="live-limit">
	<p>{LIVE_LIMIT_TEXT}</p>
	<p><a href={resolve('account/plan')}>Compare plans</a></p>
</div>
