// The owners' plan emails' content (planNoticeMail; docs/billing.md § Plan emails): what pauses and when, what stays
// on, the count of catchments the recipient can't read, and the trial's end, in English and Afrikaans. Runs under the
// skewed TZ (CLAUDE.md rule 7), so a date read in the machine's zone instead of SAST fails. The outbound security test
// covers escaping.
import { describe, expect, it } from 'vitest';
import { planNoticeMail } from './templates.js';

const TO = 'ann@example.com';
const PLAN_URL = 'http://localhost:7777/account/plan';
// 22:30 UTC on 30 Nov is 00:30 SAST on 1 Dec.
const AT = new Date('2026-11-30T22:30:00Z');

describe('planNoticeMail', () => {
	it('the grace email names the date in SAST, each catchment to pause, the others counted, and what stays on', () => {
		const mail = planNoticeMail(TO, { kind: 'grace', account: { kind: 'personal' }, pausesAt: AT, pausing: ['Bravo', 'Delta'], othersPausing: 2, keeps: ['Alpha'] }, 'en');
		expect(mail.kind).toBe('plan_notice');
		expect(mail.subject).toBe('Some catchments’ automatic updates pause on 1 Dec 2026 — IC-WBT');
		expect(mail.text).toContain('The paid plan for your IC-WBT account (ann@example.com) has ended');
		expect(mail.text).toContain('on 1 Dec 2026 the data feeds, alerts and automatic runs of these catchments pause:\n\nBravo\n\nDelta\n\n');
		expect(mail.text).toContain('and 2 more catchments of the account that you are not a member of.');
		expect(mail.text).toContain('These stay on: Alpha.');
		expect(mail.text).toContain('Nothing is deleted.');
		expect(mail.text).toContain(`Open the plan page: ${PLAN_URL}`);
	});

	it('names a team’s account by the team, and leaves out the count and the kept line when there are none', () => {
		const mail = planNoticeMail(TO, { kind: 'paused', account: { kind: 'team', team: 'Upper WUA' }, pausesAt: AT, pausing: ['Bravo'], othersPausing: 0, keeps: [] }, 'en');
		expect(mail.subject).toBe('Some catchments’ automatic updates have paused — IC-WBT');
		expect(mail.text).toContain('The paid plan for the team “Upper WUA” ended 14 days ago');
		expect(mail.text).not.toContain('more catchment');
		expect(mail.text).not.toContain('These stay on');
	});

	it('the trial email names the plan and the SAST end date', () => {
		const mail = planNoticeMail(TO, { kind: 'trial_ending', plan: 'Pro', trialEnd: AT }, 'en');
		expect(mail.subject).toBe('Your Pro trial ends on 1 Dec 2026 — IC-WBT');
		expect(mail.text).toContain('Your free Pro trial for ann@example.com ends on 1 Dec 2026.');
		expect(mail.text).toContain(`Open the plan page: ${PLAN_URL}`);
	});

	it('is written wholly in Afrikaans for an Afrikaans reader', () => {
		const mail = planNoticeMail(TO, { kind: 'trial_ending', plan: 'Pro', trialEnd: AT }, 'af');
		expect(mail.html).toMatch(/<html lang="af">/);
		expect(mail.subject).toBe('Jou Pro-proeftydperk eindig op 1 Des. 2026 — IC-WBT');
		const grace = planNoticeMail(TO, { kind: 'grace', account: { kind: 'personal' }, pausesAt: AT, pausing: ['Bravo'], othersPausing: 1, keeps: [] }, 'af');
		expect(grace.html).toMatch(/<html lang="af">/);
		expect(grace.text).toContain('en nog 1 opvanggebied van die rekening');
	});
});
