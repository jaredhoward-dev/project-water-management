// The annual renewal notice's content (renewalNoticeMail; docs/billing.md §
// Renewal notice): the plan, the period-end date in South African time, the
// next year's price, and the way to cancel, in English and Afrikaans. Runs
// under the skewed TZ (CLAUDE.md rule 7), so a date read in the machine's zone
// or in UTC instead of SAST fails. The outbound security test covers escaping.
import { describe, expect, it } from 'vitest';

import { af } from './i18n/af.js';
import { renewalNoticeMail, type RenewalNoticeFacts } from './templates.js';

const TO = 'ann@example.com';
const facts = (periodEnd: string): RenewalNoticeFacts => ({ plan: 'Pro', periodEnd: new Date(periodEnd), amountMinor: 899000, currency: 'ZAR' });
/** Intl writes the rand's group separator and the symbol gap as (narrow) no-break spaces. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');
const PLAN_URL = 'http://localhost:7777/account/plan';

describe('renewalNoticeMail', () => {
	it('runs in a skewed zone, not South Africa or UTC (positive control for the date cases)', () => {
		expect(process.env.TZ).toBeTruthy();
		expect(['UTC', 'Etc/UTC', 'Africa/Johannesburg']).not.toContain(process.env.TZ);
	});

	it('in English names the plan, the SAST period-end date, the rand amount and the cancel link', () => {
		const mail = renewalNoticeMail(TO, facts('2027-03-01T10:00:00Z'), 'en');
		expect(mail.subject).toBe('Your yearly Pro plan renews on 1 Mar 2027 — IC-WBT');
		const text = plain(mail.text);
		expect(text).toContain('Your IC-WBT Pro plan for ann@example.com is a yearly plan. This year of it ends on 1 Mar 2027.');
		expect(text).toContain('Unless you cancel, it renews on 1 Mar 2027, and R 8 990,00 is charged for the next year.');
		expect(text).toContain('If you cancel before 1 Mar 2027, nothing more is charged');
		expect(text).toContain('20 business days’ notice');
		expect(text).toContain(`Open your plan: ${PLAN_URL}`);
		expect(mail.html).toMatch(/<html lang="en">/);
		expect(mail.html).toContain(`href="${PLAN_URL}"`);
		expect(plain(mail.html)).toContain('R 8 990,00');
	});

	it('in Afrikaans names the same facts in Afrikaans words and date', () => {
		const mail = renewalNoticeMail(TO, facts('2027-03-01T10:00:00Z'), 'af');
		expect(mail.subject).toBe('Jou jaarlikse Pro-plan word op 1 Mrt. 2027 hernu — IC-WBT');
		const text = plain(mail.text);
		expect(text).toContain('Jou IC-WBT Pro-plan vir ann@example.com is ’n jaarlikse plan. Hierdie jaar van die plan eindig op 1 Mrt. 2027.');
		expect(text).toContain('Tensy jy kanselleer, word dit op 1 Mrt. 2027 hernu, en R 8 990,00 word vir die volgende jaar gehef.');
		expect(text).toContain('As jy voor 1 Mrt. 2027 kanselleer');
		expect(text).toContain(`Maak jou plan oop: ${PLAN_URL}`);
		expect(mail.html).toMatch(/<html lang="af">/);
		expect(mail.html).toContain(`href="${PLAN_URL}"`);
	});

	// 22:30 UTC on 28 Feb is 00:30 SAST on 1 Mar (UTC and St John's still say 28 Feb);
	// 21:59:59 UTC on 1 Mar is 23:59:59 SAST (Chatham already says 2 Mar).
	it.each([
		['2027-02-28T22:30:00Z', '1 Mar 2027', '1 Mrt. 2027'],
		['2027-03-01T21:59:59Z', '1 Mar 2027', '1 Mrt. 2027'],
		['2027-03-01T22:00:00Z', '2 Mar 2027', '2 Mrt. 2027']
	])('periodEnd %s is %s in South Africa, whatever the machine’s zone', (at, en, afDate) => {
		expect(renewalNoticeMail(TO, facts(at), 'en').subject).toBe(`Your yearly Pro plan renews on ${en} — IC-WBT`);
		expect(renewalNoticeMail(TO, facts(at), 'af').subject).toBe(`Jou jaarlikse Pro-plan word op ${afDate} hernu — IC-WBT`);
	});

	it('an incomplete Afrikaans catalogue sends it wholly in English, date and amount included', () => {
		const cat = af as Record<string, string | undefined>;
		const kept = cat['mail.renewal.right'];
		expect(kept, 'positive control: af has the key this test drops').toBeTruthy();
		delete cat['mail.renewal.right'];
		try {
			const mail = renewalNoticeMail(TO, facts('2027-03-01T10:00:00Z'), 'af');
			expect(mail.html).toMatch(/<html lang="en">/);
			expect(mail.subject).toBe('Your yearly Pro plan renews on 1 Mar 2027 — IC-WBT');
			for (const part of [mail.text, mail.html, mail.subject]) {
				expect(part).not.toMatch(/Mrt\.|jaarlikse|kanselleer|Maak jou plan/);
			}
			expect(plain(mail.text)).toContain('R 8 990,00 is charged for the next year');
		} finally {
			cat['mail.renewal.right'] = kept;
		}
	});

	it('says this year ends on the last paid day and renews on period_end’s date, for a period ending exactly at SAST midnight (408)', () => {
		const mail = renewalNoticeMail(TO, facts('2027-03-01T00:00:00+02:00'), 'en');
		expect(mail.subject).toBe('Your yearly Pro plan renews on 1 Mar 2027 — IC-WBT');
		expect(plain(mail.text)).toContain('This year of it ends on 28 Feb 2027.');
		expect(plain(mail.text)).toContain('Unless you cancel, it renews on 1 Mar 2027');
		// The last paid day as the backend passes it (period_end − 1 µs from Postgres) gives the same.
		const passed = renewalNoticeMail(TO, { ...facts('2027-03-01T00:00:00+02:00'), lastPaidAt: new Date('2027-02-28T23:59:59.999+02:00') }, 'en');
		expect(plain(passed.text)).toContain('This year of it ends on 28 Feb 2027.');
	});
});
