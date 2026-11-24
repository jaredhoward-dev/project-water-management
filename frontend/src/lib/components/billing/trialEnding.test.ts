import { describe, expect, it } from 'vitest';
import { TRIAL_NOTICE_MS, trialEndingText } from './trialEnding';

const NOW = Date.parse('2026-12-05T10:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('trialEndingText (the reverse trial’s ending notice)', () => {
	it('says nothing without a trial, or for a date that isn’t one', () => {
		expect(trialEndingText(null, NOW)).toBeNull();
		expect(trialEndingText(undefined, NOW)).toBeNull();
		expect(trialEndingText('soon', NOW)).toBeNull();
	});

	it('shows only in the 3 days before the end (the trial-ending email’s window)', () => {
		expect(trialEndingText(at(TRIAL_NOTICE_MS + 1), NOW)).toBeNull();
		expect(trialEndingText(at(TRIAL_NOTICE_MS), NOW)).not.toBeNull();
		expect(trialEndingText(at(60_000), NOW)).not.toBeNull();
		// Over: the worker's tick expires it, so no notice.
		expect(trialEndingText(at(0), NOW)).toBeNull();
		expect(trialEndingText(at(-60_000), NOW)).toBeNull();
	});

	it('says when it ends, what Free means, and to upgrade', () => {
		const text = trialEndingText('2026-12-07T10:00:00.000Z', NOW)!;
		expect(text).toMatch(/^Your Pro trial ends on \d{1,2} Dec 2026\./);
		expect(text).toContain('nothing is charged, nothing is deleted');
		expect(text).toContain('pause only after 14 days');
		expect(text).toMatch(/Upgrade to keep Pro\.$/);
	});
});
