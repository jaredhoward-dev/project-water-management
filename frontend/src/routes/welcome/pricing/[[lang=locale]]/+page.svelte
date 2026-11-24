<script lang="ts">
	import { untrack } from 'svelte';
	import Pricing from '#lib/components/pricing/Pricing.svelte';
	import { setLocale } from '#lib/i18n/locale.svelte.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The address's language, set before the page renders (as the landing page's +page.svelte does).
	untrack(() => void setLocale(data.locale, data.catalogue));
	$effect.pre(() => void setLocale(data.locale, data.catalogue));
</script>

<Pricing lang={data.locale} />
