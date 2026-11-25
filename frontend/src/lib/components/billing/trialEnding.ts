// The reverse trial's ending notice (342, 346, 349; docs/billing.md § The
// reverse trial, docs/ui.md § Plan and usage and § The header's notices): in
// the 3 days before a person's 14-day Pro trial ends (the same window as the
// trial-ending email, 346), the Plan page and the workspace's header say when
// it ends, what happens then (Free: nothing charged, nothing deleted, the
// 14-day grace before anything pauses) and offer Upgrade. #641's tone: an
// information note, never an error. English: the workspace and the Plan page
// are; a farmer page never shows it. Inert until REVERSE_TRIAL is on: no trial
// exists before then.
import { fmtDate } from '#lib/format/number.js';

/** How long before the end the notice shows: the trial-ending email's window (346). */
export const TRIAL_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The notice's words when the trial ending at `trialEnd` (ISO) ends within 3
 * days of `now`, else null: none yet, already over (the tick expires it), or
 * no trial (or a date that isn't one).
 */
export function trialEndingText(trialEnd: string | null | undefined, now: number = Date.now()): string | null {
	if (!trialEnd) return null;
	const end = Date.parse(trialEnd);
	if (Number.isNaN(end)) return null;
	const left = end - now;
	if (left <= 0 || left > TRIAL_NOTICE_MS) return null;
	return `Your Pro trial ends on ${fmtDate(trialEnd)}. Your account then moves to Free: nothing is charged, nothing is deleted, and catchments past Free’s live limit pause only after 14 days. Upgrade to keep Pro.`;
}
