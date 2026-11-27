<!--
	What Delineate makes (issue #374's UI list: one header button, not two):
	the catchment above one point (the draw bar's Delineate…) or sub-catchments,
	one per click (the click bar). Shown in both bars, so either switches to the
	other; picking the one already on does nothing. A pick only asks to switch
	(it may ask first, "Drop these clicks?"): the radios keep showing the
	tool that is on until the bar itself changes, so a switch called off
	never leaves the other one ticked.
-->
<script lang="ts">
	let { value, onchange }: { value: 'one' | 'clicks'; onchange: (v: 'one' | 'clicks') => void } = $props();
	const uid = $props.id();
	let one: HTMLInputElement;
	let clicks: HTMLInputElement;
	function pick(v: 'one' | 'clicks') {
		// `checked` is one-way from `value`, which doesn't change here: put the tick back on the tool that's on.
		one.checked = value === 'one';
		clicks.checked = value === 'clicks';
		onchange(v);
	}
</script>

<fieldset class="choice small" data-testid="map-delineate-choice">
	<legend class="visually-hidden">What to delineate</legend>
	<label><input type="radio" name="{uid}-what" value="one" checked={value === 'one'} bind:this={one} onchange={() => pick('one')} data-testid="map-delineate-one" /> One catchment, above a point</label>
	<label><input type="radio" name="{uid}-what" value="clicks" checked={value === 'clicks'} bind:this={clicks} onchange={() => pick('clicks')} data-testid="map-delineate-clicks" /> Sub-catchments, one per click</label>
</fieldset>

<style>
	.choice {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin: 0;
		padding: 0;
		border: 0;
	}
	/* Each choice at least 24 px tall, so the radios keep WCAG 2.5.8's target spacing (as Delineate's own radios). */
	.choice label {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
		min-height: 24px;
	}
</style>
