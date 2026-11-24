<script lang="ts">
	// Free's verified-email gate, refused (emailGate.ts): #641's words, an
	// information note rather than an error. Unverified: a Resend button
	// (POST /auth/resend-verification, as the verify banner's). Disposable:
	// no action, since the address can't be changed in the app yet.
	import { ApiError } from '#lib/api/client.js';
	import { session } from '#lib/auth/session.svelte.js';
	import { errorText } from '#lib/i18n/apiError.js';
	import { emailGateText, type EmailGateCode, type EmailGateFeature } from './emailGate';

	let { code, feature }: { code: EmailGateCode; feature: EmailGateFeature } = $props();

	let busy = $state(false);
	let status = $state('');

	async function resend() {
		busy = true;
		status = '';
		try {
			// Loaded on the press: the panels render in unit tests without SvelteKit's env, which the app's API reads.
			const [{ api }, { emailAuthApi }] = await Promise.all([import('#lib/api/index.js'), import('#lib/api/emailAuth.js')]);
			await emailAuthApi(api).resendVerification();
			status = 'Sent. Check your inbox (and spam folder).';
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && err.code === 'already_verified') {
				// Verified in another tab meanwhile: say so, and let the next try through.
				if (session.user) session.user = { ...session.user, emailVerified: true };
				status = 'Your email is verified now. Try again.';
			} else status = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<div class="alert alert-info" data-testid="email-gate" data-code={code}>
	<p>{emailGateText(code, feature, session.user?.email ?? null)}</p>
	{#if code === 'email_unverified'}
		<p><button type="button" class="btn btn-sm" onclick={resend} disabled={busy}>{busy ? 'Sending…' : 'Resend'}</button></p>
	{/if}
	<!-- Always rendered (even empty) so screen readers announce what Resend did. -->
	<span role="status" aria-live="polite">{status}</span>
</div>

