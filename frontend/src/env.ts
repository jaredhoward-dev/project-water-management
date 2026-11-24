import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_WAF_CAPTCHA_API_KEY: { public: true, static: true },
	PUBLIC_WAF_CAPTCHA_SCRIPT_URL: { public: true, static: true },
	PUBLIC_API_URL: { public: true, static: true },
	PUBLIC_CHANNELS_URL: { public: true, static: true },
	// The pricing page's reverse-trial line (docs/billing.md § The reverse trial): only `true` shows it. A build-time
	// mirror of the backend's REVERSE_TRIAL (with BILLING_ENFORCED), since the prerendered page can't ask the API.
	PUBLIC_REVERSE_TRIAL: { public: true, static: true },
	PUBLIC_TERRAIN_URL: { public: true, static: true },
	PUBLIC_TILES_GLYPHS_URL: { public: true, static: true },
	PUBLIC_TILES_URL: { public: true, static: true }
});
