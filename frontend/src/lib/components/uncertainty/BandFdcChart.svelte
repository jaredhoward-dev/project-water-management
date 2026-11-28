<!--
	One month's flow-duration curve of simulated outflow as a 5–95 % band with
	its median, against the month's EWR (docs/ui.md § Uncertainty bands). A
	month is picked from the select; "Show the numbers" under it gives the
	month's band at each exceedance point. The drawing never scales its text
	under 9.5 px (ui-playbook § 3): on a phone it scrolls sideways in its box.
	An ensemble served as EWR counts and rates only has no curves (`fdc` is
	empty, #523 I): the panel leaves the chart out, and so does this.
-->
<script lang="ts">
	import type { EnsembleBands } from '@water-management/engine';
	import { monthName } from '#lib/format/months.js';
	import { bandCells, fdcChart, fdcSummary, sig } from './bands';

	let { fdc, points: exceedance }: { fdc: EnsembleBands['fdc']; points: number[] } = $props();

	const uid = $props.id();
	let month = $state(0);
	const W = 520;
	const H = 240;
	const m = $derived(fdc[month] ?? fdc[0] ?? null);
	const chart = $derived(m ? fdcChart(m.points, exceedance, m.ewrM3Day, W, H) : null);
</script>

{#if m && chart}
	<div class="fdc">
		<div class="field">
			<label for="{uid}-m">Month</label>
			<select id="{uid}-m" bind:value={month}>
				{#each fdc as f, i (f.month)}<option value={i}>{monthName(f.month)}</option>{/each}
			</select>
		</div>
		<!-- Its 11 px labels stay at least 9.5 px: the drawing keeps 520 × 9.5 / 11 px and scrolls on a phone. -->
		<div class="scroll" data-scroll-region data-scroll-label="{monthName(m.month)} flow-duration band">
			<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t">
				<title id="{uid}-t">{fdcSummary(monthName(m.month), m.points, exceedance.length, m.ewrM3Day)}</title>
				{#each chart.yTicks as t (t.y)}
					<line class="grid" x1="56" x2={W - 10} y1={t.y} y2={t.y} />
					<text class="tick" x="50" y={t.y + 4} text-anchor="end">{t.label}</text>
				{/each}
				{#each chart.xTicks as t (t.x)}
					<text class="tick" x={t.x} y={H - 8} text-anchor="middle">{t.label}</text>
				{/each}
				{#if chart.band}<path class="band" d={chart.band} />{/if}
				{#if chart.median}<path class="median" d={chart.median} />{/if}
				{#if chart.ewrY !== null}
					<line class="ewr" x1="56" x2={W - 10} y1={chart.ewrY} y2={chart.ewrY} />
					<text class="ewr-l" x={W - 12} y={chart.ewrY - 4} text-anchor="end">EWR {sig(m.ewrM3Day)} m³/day</text>
				{/if}
			</svg>
		</div>
		<p class="muted small">
			Exceedance (% of {monthName(m.month)} days the flow is at least this) against simulated outflow, m³/day on a log scale. Shaded: 5–95 % of the kept
			parameter sets; line: their median.
		</p>
		<details class="numbers">
			<summary>Show the numbers</summary>
			<div class="table-wrap">
				<table class="data compact" aria-labelledby="{uid}-cap" data-testid="fdc-numbers">
					<caption id="{uid}-cap">{monthName(m.month)} simulated outflow at each exceedance point, m³/day, against the EWR of {sig(m.ewrM3Day)} m³/day</caption>
					<thead>
						<tr>
							<th scope="col" class="num">Exceeded on</th>
							<th scope="col" class="num">5 %</th>
							<th scope="col" class="num">Median</th>
							<th scope="col" class="num">95 %</th>
						</tr>
					</thead>
					<tbody>
						{#each m.points as b, i (i)}
							<tr>
								<th scope="row" class="num">{exceedance[i]} % of days</th>
								{#each bandCells(b) as c, k (k)}<td class="num">{c}</td>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	</div>
{/if}

<style>
	.fdc svg {
		width: 100%;
		/* 520 × 9.5 / 11: the 11 px labels never draw under 9.5 px (ui-playbook § 3); narrower, the box scrolls. */
		min-width: 450px;
		max-width: 560px;
		height: auto;
		display: block;
	}
	.scroll {
		overflow-x: auto;
	}
	.numbers {
		margin-top: 0.5rem;
	}
	.numbers summary {
		cursor: pointer;
		min-height: 24px;
	}
	.grid {
		stroke: var(--chart-grid);
		stroke-width: 1;
	}
	.tick {
		font-size: 11px;
		fill: var(--chart-axis);
	}
	.band {
		fill: var(--accent-soft);
		stroke: var(--accent);
		stroke-width: 0.5;
	}
	.median {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
	}
	.ewr {
		stroke: var(--danger);
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
	.ewr-l {
		font-size: 11px;
		fill: var(--danger);
	}
	.field {
		max-width: 12rem;
	}
</style>
