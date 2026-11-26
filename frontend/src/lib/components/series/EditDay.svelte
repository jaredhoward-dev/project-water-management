<script lang="ts">
	// Edit a day (issue #477 (a)): set or clear one day of the charted series
	// by hand, under its chart. PUT …/series/:seriesId/days/:date goes through
	// the same merge as an upload (the history keeps the values before it), and
	// marks the day as edited by hand (212_series_hand_days), which the row,
	// the details and the chart show. Days outside the series come from Add
	// data (a file or pasted rows).
	import type { SeriesMeta } from '@water-management/engine';
	import { api } from '#lib/api/index.js';
	import type { SeriesWriteResult } from '#lib/api/types.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fmtDay, fmtNum, parseDay } from '#lib/format/number.js';
	import { feedMark } from '#lib/series/provenance.js';
	import { isHandDay, lastDay, readTypedValue, savedApplies, storedValue, type DailyValues, type SavedDay } from '#lib/series/editDay.js';
	import { forgetValues } from './valuesCache';

	let {
		projectId,
		series,
		values,
		onsaved
	}: {
		projectId: string;
		series: SeriesMeta;
		/** The series' stored values (SeriesTab's); null while they load. */
		values: DailyValues | null;
		onsaved?: (meta: SeriesWriteResult) => void | Promise<void>;
	} = $props();

	const uid = $props.id();
	// A day's value as stored, up to 6 decimals and no trailing zeros: what was typed reads back as typed.
	const exact = (v: number) => fmtNum(v, 6, true);
	const id = (s: string) => `${uid}-${s}`;
	const end = $derived(lastDay(series));
	let date = $state('');
	// The day as typed, day first (parseDay, ui-playbook § 2 "A typed date is day first too"): a native date field
	// showed the browser's own order (12/30/2021 in a US browser). "2 Oct 2021", "2/10/2021" and "2021-10-02" all read.
	let dayText = $state('');
	const dayUnread = $derived(dayText.trim() !== '' && !parseDay(dayText));
	let text = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);
	let dayEl: HTMLInputElement | undefined = $state();
	// The day just saved, until the values reload (storedValue): Stored says the new value, and Save has nothing left.
	let saved = $state.raw<SavedDay | null>(null);

	const stored = $derived(storedValue(values, date, saved));
	const inRange = $derived(!!date && date >= series.startDate && date <= end);
	const typed = $derived(readTypedValue(text));
	// The stored value as the box shows it (rounded to 6 decimals) is no change either.
	const unchanged = $derived(typed.ok && stored !== undefined && (typed.value === stored || (stored !== null && text.trim() === exact(stored))));
	const edited = $derived(isHandDay(series.handDays, date) || savedApplies(saved, values, date));
	const fed = $derived(feedMark(series.feed));
	// Reasons that hold before the press disable the button; saving and "nothing to save" only mark it aria-disabled, so
	// a press keeps the focus on it (a failed save dropped it to the page; ui-playbook § Don't disable a control while
	// its own change saves). save() ignores a press while either holds.
	const blocked = $derived(!values || !inRange || !typed.ok || !!series.rebuilding);
	const idle = $derived(saving || unchanged);

	/** The day typed: once it reads as a day, that day is picked; until then none is. */
	function typeDay(typedDay: string) {
		dayText = typedDay;
		const next = parseDay(typedDay) ?? '';
		if (next !== date) pick(next);
	}

	/** A day picked: its stored value in the box, ready to correct (blank for a gap). */
	function pick(next: string) {
		date = next;
		error = null;
		done = null;
		const v = storedValue(values, next, saved);
		text = v === undefined || v === null ? '' : exact(v);
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (blocked || idle || !typed.ok || !values) return;
		const before = values;
		const value = typed.value;
		saving = true;
		error = null;
		done = null;
		try {
			const meta = await api.series.setDay(projectId, series.id, date, value);
			forgetValues(projectId, series.id);
			saved = { values: before, date, value };
			done = value === null ? `Cleared ${fmtDay(date)}.` : `Saved ${fmtDay(date)}: ${exact(value)} ${series.unit}.`;
			await onsaved?.(meta);
			// Nothing is left to save: the Day field takes the focus, its text selected, ready for the next day to correct.
			dayEl?.focus();
			dayEl?.select();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="edit-day" role="group" aria-labelledby={id('h')} data-testid="edit-day">
	<div class="edit-h"><h3 id={id('h')}>Edit a day</h3><HelpTip key="series-edit-day" /></div>
	{#if series.rebuilding}
		<p class="hint muted" data-testid="edit-day-rebuilding">A data feed is replacing this series. Edit its days once the replacement is in.</p>
	{:else}
		<form onsubmit={save}>
			<div class="form-row">
				<div class="field">
					<label for={id('date')}>Day</label>
					<input
						id={id('date')}
						bind:this={dayEl}
						type="text"
						class="day"
						value={dayText}
						oninput={(e) => typeDay(e.currentTarget.value)}
						onblur={() => {
							if (date) dayText = fmtDay(date);
						}}
						placeholder="e.g. 15 Nov 2021"
						autocomplete="off"
						spellcheck="false"
						aria-invalid={dayUnread || (!!date && !inRange) ? 'true' : undefined}
						aria-describedby={id('stored')}
					/>
				</div>
				<div class="field value">
					<label for={id('value')}>Value ({series.unit})</label>
					<input
						id={id('value')}
						inputmode="decimal"
						autocomplete="off"
						bind:value={text}
						disabled={!inRange}
						aria-invalid={!typed.ok ? 'true' : undefined}
						aria-describedby={id('stored')}
					/>
				</div>
				<button type="submit" class="btn btn-sm btn-primary save" disabled={blocked} aria-disabled={idle ? 'true' : undefined}>{saving ? 'Saving…' : inRange && typed.ok && typed.value === null ? 'Clear the day' : 'Save the day'}</button>
			</div>
			<p class="hint muted" id={id('stored')} data-testid="edit-day-stored">
				{#if dayUnread}
					<span class="warn-text">Type a day, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15.</span>
					The series runs from {fmtDay(series.startDate)} to {fmtDay(end)}.
				{:else if !date}
					Pick a day from {fmtDay(series.startDate)} to {fmtDay(end)}, day first. Leave the value blank to clear the day (no reading).
				{:else if !inRange}
					<span class="warn-text">{fmtDay(date)} is outside the series ({fmtDay(series.startDate)} to {fmtDay(end)}). Add days outside it from Add data, as a file or pasted rows.</span>
				{:else if !values}
					Loading the stored values…
				{:else}
					Stored: {stored === null || stored === undefined ? 'no reading' : `${exact(stored)} ${series.unit}`}{edited ? ', edited by hand' : ''}.
					{#if fed}A day you edit is yours: the data feed won’t write over it.{/if}
				{/if}
			</p>
			{#if !typed.ok}<p class="hint warn-text" data-testid="edit-day-invalid">{typed.error}</p>{/if}
			{#if error}<div class="alert alert-error" role="alert" data-testid="edit-day-error">{error}</div>{/if}
			{#if done}<p class="ok" role="status" data-testid="edit-day-done">{done} Kept in History, where the value before can be restored.</p>{/if}
		</form>
	{/if}
</div>

<style>
	.edit-day {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
		font-size: 0.85rem;
	}
	.edit-h {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.edit-h h3 {
		margin: 0;
		font-size: 0.95rem;
	}
	.form-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
	}
	.field {
		margin: 0;
	}
	.value input {
		width: 9rem;
	}
	/* Wide enough for "30 Sep 2021" and the placeholder ("e.g. 15 Nov 2021", which reads as an example, not a day
	   already picked), as the native date field was. */
	.day {
		width: 11rem;
	}
	.save {
		min-height: 32px;
	}
	.hint {
		margin: 0.4rem 0 0;
	}
	.warn-text {
		color: var(--warning);
		font-weight: 600;
	}
	.ok {
		color: var(--success);
		margin: 0.4rem 0 0;
	}
	/* The Data page's column, not the viewport (ui-playbook § 2: container queries). */
	@container data-page (max-width: 640px) {
		.field,
		.value input,
		.day,
		.save {
			width: 100%;
		}
		.field input,
		.save {
			min-height: 44px;
		}
	}
</style>
