<!-- i18n-section: account -->
<script lang="ts">
	// The Account page's "Email address" panel (issue #641 item 5, 347_email_change):
	// a new address and the current password. The server mails a link to the new
	// address and changes nothing until it is used (POST /auth/change-email, then
	// the link's /confirm-email-change page). It answers the same whether or not
	// the new address already has an account, so this says only where the link went.
	import { api, ApiError } from '#lib/api/index.js';
	import { emailAuthApi } from '#lib/api/emailAuth.js';
	import { session } from '#lib/auth/session.svelte.js';
	import PasswordInput from '#lib/components/common/PasswordInput.svelte';
	import { errorText } from '#lib/i18n/apiError.js';
	import { t } from '#lib/i18n/locale.svelte.js';

	const emailAuth = emailAuthApi(api);

	let newEmail = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let errorField = $state<'email' | 'password' | null>(null);
	/** The address the link went to, once sent. */
	let sentTo = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		sentTo = null;
		const address = newEmail.trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
			error = t('Enter the new email address.');
			errorField = 'email';
			return;
		}
		if (!password) {
			error = t('Enter your current password.');
			errorField = 'password';
			return;
		}
		error = null;
		errorField = null;
		busy = true;
		try {
			const { email } = await emailAuth.changeEmail(address, password);
			sentTo = email;
			newEmail = password = '';
		} catch (err) {
			error = err instanceof ApiError && err.status === 403 ? t('Your current password is wrong.') : errorText(err);
			errorField = err instanceof ApiError && err.status === 403 ? 'password' : err instanceof ApiError && err.status === 400 ? 'email' : null;
		} finally {
			busy = false;
		}
	}
</script>

<section class="panel" aria-labelledby="change-email-h">
	<h2 id="change-email-h">{t('Email address')}</h2>
	<p class="muted intro">{t('We send a link to the new address. Your account keeps {email} until you open that link.', { email: session.user?.email ?? '' })}</p>
	<form onsubmit={submit} novalidate>
		{#if error}<div class="alert alert-error" role="alert" id="change-email-error">{error}</div>{/if}
		<div class="field">
			<label for="new-email">{t('New email address')}</label>
			<input
				id="new-email"
				type="email"
				autocomplete="email"
				inputmode="email"
				maxlength="254"
				aria-invalid={errorField === 'email' ? 'true' : undefined}
				aria-describedby={errorField === 'email' ? 'change-email-error' : undefined}
				bind:value={newEmail}
			/>
		</div>
		<div class="field">
			<label for="change-email-password">{t('Current password')}</label>
			<PasswordInput
				id="change-email-password"
				autocomplete="current-password"
				maxlength={200}
				aria-invalid={errorField === 'password' ? 'true' : undefined}
				aria-describedby={errorField === 'password' ? 'change-email-error' : undefined}
				bind:value={password}
			/>
		</div>
		<div class="actions">
			<button class="btn btn-primary" type="submit" disabled={busy}>
				{busy ? t('Sending…') : t('Send the link')}
			</button>
			<p class="status" role="status" aria-live="polite">
				{sentTo ? t('If {email} can take the change, a link is on its way there. Open it to finish.', { email: sentTo }) : ''}
			</p>
		</div>
	</form>
</section>

<style>
	/* The Account page's card look (routes/account/+page.svelte), as DeleteAccount.svelte repeats it. */
	.panel {
		padding: 1rem 1.1rem 0.75rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
	}
	.intro {
		margin: 0 0 0.75rem;
		max-width: 60ch;
	}
	.field {
		max-width: 36rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.status {
		margin: 0;
		font-size: 13px;
		color: var(--text-2);
	}
</style>
