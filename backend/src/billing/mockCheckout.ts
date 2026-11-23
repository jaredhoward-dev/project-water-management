// The mock provider's checkout and portal pages (issue #641 Phase 3,
// "Local-first"; docs/billing.md § Checkout and portal). Dev-only: every
// route here is 404 unless BILLING_PROVIDER is `mock`, which production
// refuses (config/production.ts), so they never answer on the deployed API.
//
// Why a backend page and not an SPA route: the page's outcome is a webhook
// event signed with BILLING_WEBHOOK_SECRET, and that key must stay on the
// server. A backend page signs and posts in the same process; an SPA page
// would need a dev-only API to do the same, and would ship its code in the
// production bundle. These pages are plain HTML forms with no script.
//
//   GET  /billing/mock/checkout?t=…             the plan and price, and three buttons: Simulate: pays, declines, cancels
//   POST /billing/mock/checkout?t=…&outcome=…   pays: checkout.session.completed and customer.subscription.created,
//                                               each signed with the dev key and posted to POST /billing/webhook/mock
//                                               (the real route, so app_billing_apply writes the subscription), then
//                                               303 to the plan page; declines: the page again with the card declined
//                                               and nothing sent (as Stripe's hosted page keeps the person there);
//                                               cancels: 303 back with ?checkout=cancelled, nothing sent
//   GET  /billing/mock/portal?t=…               the subscription, cancel at the period end, and back
//   POST /billing/mock/portal?t=…&action=cancel customer.subscription.updated with cancel_at_period_end, then 303 back
//
// The token (provider/mock.ts) is the credential: signed with the dev key,
// for one account, for an hour. The POSTs read nothing from the body (the
// choice is in the form's action URL), so no body is ever parsed here.
import { Hono, type Context } from 'hono';
import { logEvent } from '../logging/logEvent.js';
import { billingProvider } from './provider.js';
import { cancelAtPeriodEndEvent, paidEvents, readMockSession, signedDelivery, type MockSession } from './provider/mock.js';
import { SIGNATURE_HEADER } from './provider/signature.js';
import { billingWebhookRoutes } from './webhook.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · IC-WBT (mock)</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}
.banner{background:#fff3cd;border:1px solid #c9a227;padding:.5rem .75rem;border-radius:4px}
form{display:inline-block;margin:.25rem .5rem .25rem 0}button{font:inherit;padding:.5rem 1rem;cursor:pointer}
.err{color:#a40000}</style></head>
<body><p class="banner" data-mock-banner>Mock payment page: nothing is charged. This page exists only with BILLING_PROVIDER=mock.</p>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}

/** The mock session token, the pages' one credential (auth/token-confusion.security.db.test.ts lists the read). */
const tokenOf = (c: Context) => c.req.query('t') ?? '';

/** The person's own plan page (SITE_URL, as billing/routes.ts makes the return links): where a stale or failed page sends them back to. */
const planPage = () => `${(process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '')}/account/plan`;

/** A return URL without its `?checkout=…`: the plan page the session came from (the person's or a team's). */
const pageOf = (url: string) => {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname}`;
	} catch {
		return planPage();
	}
};

const backLink = (url: string) => `<p><a href="${esc(url)}" data-action="return">Back to the plan page</a></p>`;

/** The session, or a 404 page: the provider isn't the mock, or the token is forged or stale. */
function session<K extends MockSession['kind']>(c: Context, kind: K): Extract<MockSession, { kind: K }> | Response {
	const provider = billingProvider();
	if (provider?.name !== 'mock') return c.json({ error: 'not found' }, 404);
	const s = readMockSession(process.env.BILLING_WEBHOOK_SECRET?.trim() || undefined, tokenOf(c));
	if (!s || s.kind !== kind) return c.html(page('This page has expired', `<p>Start again from the Plan and usage page.</p>\n${backLink(planPage())}`), 404);
	return s as Extract<MockSession, { kind: K }>;
}

/** Post one event to the real webhook route, signed with the dev key; whether it was taken (200). */
async function deliver(event: Record<string, unknown>): Promise<boolean> {
	const secret = process.env.BILLING_WEBHOOK_SECRET?.trim();
	if (!secret) return false;
	const { body, signature } = signedDelivery(secret, event);
	const res = await billingWebhookRoutes.request('/webhook/mock', {
		method: 'POST',
		headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
		body
	});
	return res.status === 200;
}

const failed = (c: Context, back: string) =>
	c.html(page('Something went wrong', `<p class="err" data-mock-error>The webhook refused the event; the backend log says why.</p>\n${backLink(back)}`), 502);

const tokenQs = (c: Context) => `t=${encodeURIComponent(tokenOf(c))}`;

function checkoutPage(c: Context, s: Extract<MockSession, { kind: 'checkout' }>, declined: boolean): string {
	const qs = tokenQs(c);
	const per = s.interval === 'year' ? 'a year' : 'a month';
	return page(
		`Subscribe to ${s.planName}`,
		`<p data-mock-price>${esc(money(s.amountMinor, s.currency))} ${per}.</p>
${declined ? '<p class="err" role="alert" data-mock-declined>Your card was declined (simulated). Nothing was charged; choose again.</p>' : ''}
<p>Which outcome should the mock simulate?</p>
<form method="post" action="?${qs}&amp;outcome=pays"><button type="submit" data-outcome="pays">Simulate: pays</button></form>
<form method="post" action="?${qs}&amp;outcome=declines"><button type="submit" data-outcome="declines">Simulate: declines</button></form>
<form method="post" action="?${qs}&amp;outcome=cancels"><button type="submit" data-outcome="cancels">Simulate: cancels</button></form>`
	);
}

export const mockCheckoutRoutes = new Hono()
	.get('/mock/checkout', (c) => {
		const s = session(c, 'checkout');
		if (s instanceof Response) return s;
		c.header('Cache-Control', 'no-store');
		return c.html(checkoutPage(c, s, false));
	})
	.post('/mock/checkout', async (c) => {
		const s = session(c, 'checkout');
		if (s instanceof Response) return s;
		const outcome = c.req.query('outcome');
		c.header('Cache-Control', 'no-store');
		if (outcome === 'cancels') return c.redirect(s.cancelUrl, 303);
		if (outcome === 'declines') return c.html(checkoutPage(c, s, true), 402);
		if (outcome !== 'pays') return c.json({ error: 'unknown outcome' }, 400);
		for (const event of paidEvents(s)) if (!(await deliver(event))) return failed(c, pageOf(s.successUrl));
		logEvent('info', { event: 'billing_mock_checkout', outcome, plan: s.planCode });
		return c.redirect(s.successUrl, 303);
	})
	.get('/mock/portal', (c) => {
		const s = session(c, 'portal');
		if (s instanceof Response) return s;
		const qs = tokenQs(c);
		const sub = s.subscription;
		// The plan's name ("Pro"), as the plan page says it; a token signed before the name was carried has the code only.
		const planName = sub ? (sub.planName ?? sub.planCode) : '';
		const state = !sub
			? '<p data-mock-subscription="none">No subscription: there is nothing to manage.</p>'
			: sub.cancelAtPeriodEnd
				? `<p data-mock-subscription="ending">Your ${esc(planName)} subscription ends on ${esc(sub.periodEnd.slice(0, 10))}.</p>`
				: `<p data-mock-subscription="${esc(sub.status)}">Your ${esc(planName)} subscription renews on ${esc(sub.periodEnd.slice(0, 10))}.</p>
<form method="post" action="?${qs}&amp;action=cancel"><button type="submit" data-action="cancel">Cancel at the end of the period</button></form>`;
		c.header('Cache-Control', 'no-store');
		return c.html(page('Manage billing', `${state}\n<p><a href="${esc(s.returnUrl)}" data-action="return">Back to IC-WBT</a></p>`));
	})
	.post('/mock/portal', async (c) => {
		const s = session(c, 'portal');
		if (s instanceof Response) return s;
		if (c.req.query('action') !== 'cancel') return c.json({ error: 'unknown action' }, 400);
		const event = cancelAtPeriodEndEvent(s);
		if (event && !(await deliver(event))) return failed(c, s.returnUrl);
		logEvent('info', { event: 'billing_mock_portal', action: 'cancel' });
		c.header('Cache-Control', 'no-store');
		return c.redirect(s.returnUrl, 303);
	});
