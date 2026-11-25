// The farmer emails in another language (WP-2.5), against a made-up
// catalogue that marks each word it supplies ("[af] …"): test data only,
// never wording that ships. The real af.ts holds only reviewed text.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./i18n/af.js', async () => {
	const { en } = await vi.importActual<typeof import('./i18n/en.js')>('./i18n/en.js');
	// Complete: a test drops a key to see what an incomplete catalogue sends.
	const af = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `[af] ${v}`]));
	return { af };
});

const { af } = await import('./i18n/af.js');
const { emailChangeTakenMail, farmerInviteMail, resetPasswordMail, verifyEmailMail } = await import('./templates.js');
const url = 'http://localhost:7777/verify-email?token=abc';

describe('farmer emails in Afrikaans', () => {
	it('verify and reset come out in the account’s language, marked lang="af", link and product intact', () => {
		for (const mail of [
			verifyEmailMail('ann@example.com', url, 'af'),
			resetPasswordMail('ann@example.com', url, 'af'),
			emailChangeTakenMail('ann@example.com', { kind: 'reset', url }, 'af'),
			emailChangeTakenMail('ann@example.com', { kind: 'confirm', url }, 'af')
		]) {
			expect(mail.subject).toMatch(/^\[af\] .* — IC-WBT$/);
			// The app's name is never translated: the sign-off stays the full English name (issue #551).
			expect(mail.text.trimEnd().endsWith('— Integrated Catchment - Water Balance Tool (IC-WBT)')).toBe(true);
			expect(mail.html).toContain('— Integrated Catchment - Water Balance Tool (IC-WBT)</p>');
			expect(mail.html).toMatch(/<html lang="af">/);
			expect(mail.html).toContain(`href="${url}"`);
			expect(mail.html).toContain('[af] If the button');
			expect(mail.text).toContain(url);
			expect(mail.text).toContain('ann@example.com');
			expect(mail.text).not.toMatch(/^Please confirm|^Someone asked/m);
		}
	});

	it('the invite in Afrikaans, farms joined with the catalogue’s "and"', () => {
		const mail = farmerInviteMail('f@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek', 'Rand'] }, 'sign-up', 'af');
		expect(mail.html).toMatch(/<html lang="af">/);
		expect(mail.subject).toBe('[af] Ann invited you to see Hoek [af] and Rand in Kloof');
	});

	// WCAG 3.1.1: one key short, no Afrikaans email may claim to be English, nor the other way round.
	it('a catalogue missing one key sends every email wholly in English, marked lang="en"', () => {
		const cat = af as Record<string, string | undefined>;
		const kept = cat['mail.farmer.privacy'];
		delete cat['mail.farmer.privacy'];
		try {
			const mails = [
				farmerInviteMail('f@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek', 'Rand'] }, 'sign-up', 'af'),
				// One that never uses the missing key is English too: the language, not the email, is incomplete.
				verifyEmailMail('ann@example.com', url, 'af')
			];
			for (const mail of mails) {
				expect(mail.html).toMatch(/<html lang="en">/);
				expect(mail.html).not.toContain('[af]');
				expect(mail.text).not.toContain('[af]');
				expect(mail.subject).not.toContain('[af]');
			}
			expect(mails[0]!.subject).toBe('Ann invited you to see Hoek and Rand in Kloof');
			expect(mails[0]!.text).toContain("You will see your own hydrological unit's water");
			expect(mails[1]!.subject).toBe('Confirm your email address — IC-WBT');
		} finally {
			cat['mail.farmer.privacy'] = kept;
		}
	});

	it('still escapes user-controlled names inside translated wording', () => {
		const mail = farmerInviteMail('f@example.com', url, 'Eve <b>', { catchment: '"><img src=x>', farms: ['<script>x</script>'] }, 'confirm', 'af');
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).not.toContain('<img');
		expect(mail.html).toContain('&lt;script&gt;');
		expect(mail.text).toContain('[af] This link expires in 48 hours.');
	});

	it('English stays English whatever af holds', () => {
		expect(verifyEmailMail('ann@example.com', url).html).toMatch(/<html lang="en">/);
		expect(verifyEmailMail('ann@example.com', url, 'en').subject).toBe('Confirm your email address — IC-WBT');
	});
});
