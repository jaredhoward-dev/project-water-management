<!-- i18n-section: verify.change -->
<script lang="ts">
	// Reached from the email sent to a NEW address on the Account page (347_email_change):
	// opening it switches the account to that address. Works signed in or out (the token
	// is the proof); signed in to that account, the session shows the new address at once.
	import { onMount } from 'svelte';
	import { guardedGoto } from '#lib/nav/leaveGuard.js';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '#lib/api/index.js';
	import { emailAuthApi, linkToken } from '#lib/api/emailAuth.js';
	import { session } from '#lib/auth/session.svelte.js';
	import AuthCard from '#lib/components/layout/AuthCard.svelte';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { APP_SHORT_NAME } from '#lib/brand.js';
	import { errorText } from '#lib/i18n/apiError.js';

	const emailAuth = emailAuthApi(api);
	const token = linkToken(page.url);

	let status = $state<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
	let failure = $state<string | null>(null);
	let changedTo = $state('');

	onMount(async () => {
		// A real (not shallow) replace: a shallow entry keeps the tokened URL in SvelteKit's history state and Back
		// from another page navigates to it, sending the spent link again (account.spec.ts). The component stays.
		if (page.url.searchParams.has('token')) void guardedGoto(resolve('verify-email/change'), { replace: true, reset: false });
		if (!token) return;
		try {
			const { email } = await emailAuth.confirmEmailChange(token);
			changedTo = email;
			// Signed in: reload who this is, so the header and the Account page show the new address.
			if (session.user) session.user = await api.auth.me().catch(() => session.user);
			status = 'done';
		} catch (err) {
			failure = errorText(err);
			status = 'failed';
		}
	});
</script>

<svelte:head>
	<title>{t('{page} · {app}', { page: t('Confirm your new email address'), app: APP_SHORT_NAME })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('Confirm your new email address')}>
	{#if status === 'working'}
		<p role="status">{t('Changing your email address…')}</p>
	{:else if status === 'done'}
		<div class="alert alert-info" role="status">
			{t('Your email address is now {email}. Sign in with it from now on.', { email: changedTo })}
		</div>
		{#if session.user}
			<a class="btn btn-primary" href={resolve('account')}>{t('Back to your account')}</a>
		{:else}
			<a class="btn btn-primary" href={resolve('login')}>{t('Sign in')}</a>
		{/if}
	{:else}
		<div class="alert alert-error" role="alert">{failure ?? t('This link is invalid or has expired. Ask for a new one.')}</div>
		{#if session.user}
			<a class="btn" href={resolve('account')}>{t('Back to your account')}</a>
		{:else}
			<a class="btn" href={resolve('login')}>{t('Sign in')}</a>
		{/if}
	{/if}
</AuthCard>
