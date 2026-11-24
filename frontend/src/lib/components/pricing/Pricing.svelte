<!-- i18n-section: landing.pricing -->
<script lang="ts">
	// The public pricing page (issue #641 Phase 4; docs/ui.md § Pricing page):
	// Free, Pro and Team, at /welcome/pricing and /welcome/pricing/<code>,
	// prerendered like the landing page (issue #137). Free never limits
	// modelling; the plans differ only in the assistant, live operations,
	// server reports and issued evidence packs. Every figure comes from the
	// plan figures (pricing.ts), never typed here. Farmers, viewers and
	// assessors are always free, and said so first. Checkout's disclosures and
	// consent are not on this page (#641 Phase 4, later). Pro's reverse-trial
	// line shows only in a build with PUBLIC_REVERSE_TRIAL=true (pricing.ts
	// reverseTrialDays), its length from the plan figures' trialDays.
	import { resolve } from '$app/paths';
	import { PUBLIC_REVERSE_TRIAL } from '$app/env/public';
	import { APP_NAME, APP_SHORT_NAME } from '#lib/brand.js';
	import { basePath } from '#lib/nav/base.js';
	import { page } from '$app/state';
	import BrandMark from '#lib/components/layout/BrandMark.svelte';
	import LanguageSwitch from '#lib/i18n/LanguageSwitch.svelte';
	import { language, LANGUAGES, plural, t, tn, wordsLang, type Locale } from '#lib/i18n/locale.svelte.js';
	import { landingPath, PRICING_PATH, pricingPath } from '#lib/auth/session.svelte.js';
	import { assistantTimesFree, monthsFreeYearly, planFigures, rand, reverseTrialDays } from './pricing';

	let { lang }: { lang: Locale } = $props();

	const free = planFigures('free');
	const pro = planFigures('pro');
	const team = planFigures('team');
	const trialDays = reverseTrialDays(PUBLIC_REVERSE_TRIAL, pro);

	const LIVE = plural({
		one: 'Live data feeds, automatic runs, alerts and published farm views on {n} catchment',
		other: 'Live data feeds, automatic runs, alerts and published farm views on {n} catchments'
	});
	const REPORTS = plural({ one: '{n} server PDF report a month', other: '{n} server PDF reports a month' });
	const MONTHS_FREE = plural({ one: 'or {price} a year ({n} month free)', other: 'or {price} a year ({n} months free)' });
	const TRIAL = plural({
		one: '{n} day of Pro free when you sign up, no card needed. Then Free, unless you choose a plan.',
		other: '{n} days of Pro free when you sign up, no card needed. Then Free, unless you choose a plan.'
	});
	const EDITORS = plural({ one: '{n} editor included', other: '{n} editors included' });
	const PACKS = plural({
		one: '{n} issued evidence pack a month included, then {price} each',
		other: '{n} issued evidence packs a month included, then {price} each'
	});

	const abs = (path: string) => new URL(`${basePath()}${path}`, page.url.href).href;
	const title = $derived(t('Plans and prices: {app}', { app: APP_SHORT_NAME }));
	const description = $derived(
		t('Modelling is free and unlimited on every plan. Pro and Team add live operations on every catchment, more of the assistant, unlimited reports and cheaper evidence packs.')
	);
	const ogLocale = (l: Locale) => language(l).intl.replace('-', '_');
	const switchHref = (l: Locale) => `${basePath()}${pricingPath(l)}`;
	const homeHref = $derived(`${basePath()}${landingPath(lang)}`);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={abs(pricingPath(wordsLang()))} />
	{#each LANGUAGES as l (l.code)}
		<link rel="alternate" hreflang={l.code} href={abs(pricingPath(l.code))} />
	{/each}
	<link rel="alternate" hreflang="x-default" href={abs(PRICING_PATH)} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={APP_NAME} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={abs(pricingPath(wordsLang()))} />
	<meta property="og:locale" content={ogLocale(wordsLang())} />
</svelte:head>

<div class="landing pricing">
	<header class="top">
		<a class="lockup" href={homeHref} aria-label={t('{app}, home', { app: APP_SHORT_NAME })}>
			<BrandMark size={32} />
			<span>{APP_SHORT_NAME}</span>
		</a>
		<nav class="nav" aria-label={t('Account')}>
			<LanguageSwitch compact addressOf={switchHref} />
			<a class="btn" href={resolve('login')}>{t('Sign in')}</a>
		</nav>
	</header>

	<main class="page-body">
		<div class="wrap">
			<section class="intro" aria-labelledby="pricing-title">
				<h1 id="pricing-title">{t('Plans and prices')}</h1>
				<p class="lead">
					{t('Modelling is never limited, on any plan: catchments, runs, calibration, scenarios, comparisons, the map and exports. The plans differ only in the assistant, running catchments live, server reports and issued evidence packs.')}
				</p>
				<ul class="always" data-testid="pricing-always-free">
					<li><strong>{t('Farmers and viewers are always free.')}</strong> {t('Invite as many as you like, on every plan.')}</li>
					<li><strong>{t('Assessors verify evidence packs free.')}</strong> {t('Checking a pack’s code needs no account.')}</li>
				</ul>
			</section>

			<ul class="plans" aria-label={t('Plans')}>
				<li class="plan" data-plan="free">
					<h2>{t('Free')}</h2>
					<p class="price"><span class="amount" data-testid="price-free">{rand(free.priceMonthlyMinor)}</span></p>
					<p class="who">{t('For study, research and a catchment of your own. Non-commercial use only.')}</p>
					<ul class="includes">
						<li>{t('Unlimited catchments, runs, calibration, scenarios and exports')}</li>
						<li>{tn(LIVE, free.liveCatchments ?? 0)}</li>
						<li>{tn(REPORTS, free.reportsPerMonth ?? 0)}</li>
						<li>{t('A small assistant allowance each day and month')}</li>
						<li>{t('Issued evidence packs at {price} each', { price: rand(free.packPriceMinor) })}</li>
					</ul>
				</li>
				<li class="plan featured" data-plan="pro">
					<h2>{t('Pro')}</h2>
					<p class="price">
						<span class="amount" data-testid="price-pro">{rand(pro.priceMonthlyMinor)}</span> <span class="per">{t('a month')}</span>
					</p>
					<p class="yearly">{tn(MONTHS_FREE, monthsFreeYearly(pro), { price: rand(pro.priceAnnualMinor) })}</p>
					{#if trialDays !== null}
						<p class="trial" data-testid="pro-trial">{tn(TRIAL, trialDays)}</p>
					{/if}
					<p class="who">{t('For one hydrologist, including work for clients.')}</p>
					<ul class="includes">
						<li>{t('Everything in Free, for commercial work')}</li>
						<li>{t('Live data feeds, automatic runs, alerts and published farm views on every catchment')}</li>
						<li>{t('Unlimited server PDF reports, and scheduled report emails')}</li>
						<li>{t('About {n} times Free’s assistant allowance', { n: assistantTimesFree(pro) })}</li>
						<li>{t('Issued evidence packs at {price} each', { price: rand(pro.packPriceMinor) })}</li>
					</ul>
				</li>
				<li class="plan" data-plan="team">
					<h2>{t('Team')}</h2>
					<p class="price">
						<span class="amount" data-testid="price-team">{rand(team.priceMonthlyMinor)}</span> <span class="per">{t('a month')}</span>
					</p>
					<p class="yearly">{tn(MONTHS_FREE, monthsFreeYearly(team), { price: rand(team.priceAnnualMinor) })}</p>
					<p class="who">{t('For a water user association or a consultancy.')}</p>
					<ul class="includes">
						<li>{t('Everything in Pro, for the whole team')}</li>
						<li>
							{tn(EDITORS, team.seatsIncluded)}; {t('each further editor {month} a month or {year} a year', {
								month: rand(team.extraSeatMonthlyMinor ?? 0),
								year: rand(team.extraSeatAnnualMinor ?? 0)
							})}
						</li>
						<li>{t('About {n} times Free’s assistant allowance for each editor, shared by the team', { n: assistantTimesFree(team) })}</li>
						<li>{tn(PACKS, team.packsIncludedPerMonth, { price: rand(team.packPriceMinor) })}</li>
					</ul>
				</li>
			</ul>

			<section class="notes" aria-labelledby="notes-title">
				<h2 id="notes-title">{t('Good to know')}</h2>
				<ul>
					<li>{t('Prices are in rand. No VAT is charged.')}</li>
					<li>{t('Free is for non-commercial use: work for a paying client, or as part of a business, needs Pro or Team.')}</li>
					<li>{t('Your data is never held back by a plan: downloading a project, your data or a run’s spreadsheet is free on every plan, also after a downgrade.')}</li>
					<li>{t('Results are the same on every plan: calibration, the ecological reserve and the model’s checks are never a paid extra.')}</li>
				</ul>
			</section>

			<section class="closing" aria-labelledby="closing-title">
				<h2 id="closing-title">{t('Start free, and change plans when you need to.')}</h2>
				<div class="actions">
					<a class="btn btn-primary btn-lg" href={resolve('register')}>{t('Create an account')}</a>
					<a class="btn btn-lg" href={homeHref}>{t('Back to the home page')}</a>
				</div>
			</section>
		</div>
	</main>

	<footer class="foot">
		<div class="wrap foot-row">
			<span class="lockup small"><BrandMark size={24} /><span>{APP_NAME}</span></span>
			<nav aria-label={t('Footer')}>
				<a href={resolve('privacy')}>{t('Privacy notice')}</a>
				<a href={resolve('terms')}>{t('Terms of use')}</a>
				<a href={resolve('methods')}>{t('How the model is checked')}</a>
			</nav>
		</div>
	</footer>
</div>

<style>
	:global(html:has(.landing)) {
		background: var(--bg);
	}
	.landing {
		--wrap: 1200px;
		min-height: 100vh;
		background: var(--bg);
		color: var(--text);
		overflow-x: clip;
	}
	.wrap {
		position: relative;
		max-width: var(--wrap);
		margin-inline: auto;
		padding-inline: clamp(var(--gutter), 4vw, 3rem);
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		max-width: var(--wrap);
		margin-inline: auto;
		padding: 1rem clamp(var(--gutter), 4vw, 3rem);
	}
	.lockup {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--text);
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.1rem;
		text-decoration: none;
	}
	.lockup.small {
		font-size: 0.95rem;
	}
	.nav {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.75rem;
	}
	.nav .btn {
		min-height: var(--tap);
	}
	.page-body {
		position: relative;
		display: block;
	}
	h1,
	h2 {
		font-family: var(--font-display);
		letter-spacing: -0.015em;
	}
	h1 {
		margin: clamp(1.5rem, 4vw, 3rem) 0 1rem;
		font-size: clamp(2rem, 4.5vw, 3rem);
	}
	.lead {
		max-width: 62ch;
		margin: 0 0 1.25rem;
		font-size: 1.1rem;
		color: var(--text-muted);
	}
	.always {
		display: grid;
		gap: 0.5rem;
		margin: 0 0 2rem;
		padding: 1rem 1.25rem;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
		list-style: none;
	}
	.plans {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
		gap: 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.plan {
		display: flex;
		flex-direction: column;
		padding: 1.5rem;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
	}
	.plan.featured {
		border-color: var(--accent);
		border-width: 2px;
	}
	.plan h2 {
		margin: 0 0 0.5rem;
		font-size: 1.5rem;
	}
	.price {
		margin: 0;
	}
	.amount {
		font-family: var(--font-display);
		font-size: 2rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.per,
	.yearly {
		color: var(--text-muted);
	}
	.yearly {
		margin: 0.25rem 0 0;
	}
	.trial {
		margin: 0.75rem 0 0;
		font-weight: 600;
	}
	.who {
		margin: 0.75rem 0 1rem;
	}
	.includes {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding-left: 1.2rem;
	}
	.notes {
		margin-top: clamp(2rem, 5vw, 3.5rem);
	}
	.notes h2 {
		font-size: 1.5rem;
	}
	.notes ul {
		display: grid;
		gap: 0.5rem;
		max-width: 70ch;
		padding-left: 1.2rem;
	}
	.closing {
		--focus: var(--brand-panel-focus);
		margin-top: clamp(2.5rem, 6vw, 4.5rem);
		padding: clamp(2rem, 5vw, 3.5rem);
		border: 1px solid var(--brand-panel);
		border-radius: 16px;
		background: var(--brand-panel);
		color: var(--brand-panel-text);
		text-align: center;
	}
	.closing h2 {
		margin: 0 0 1.5rem;
		font-size: clamp(1.5rem, 3vw, 2rem);
	}
	.closing .actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.75rem;
	}
	.closing .btn:not(.btn-primary) {
		border-color: var(--brand-panel-line);
		background: transparent;
		color: var(--brand-panel-text);
	}
	.btn-lg {
		min-height: 48px;
		padding-inline: 1.4rem;
		font-size: 1rem;
	}
	.foot {
		margin-top: clamp(3rem, 7vw, 5rem);
		padding-block: 2.5rem 3rem;
		border-top: 1px solid var(--border);
	}
	.foot-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem 2rem;
	}
	.foot nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
	}
	@media (prefers-color-scheme: dark) {
		.closing {
			border-color: var(--border);
		}
	}
	@media (max-width: 420px) {
		.top .lockup span {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}
</style>
