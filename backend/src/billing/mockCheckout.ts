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
//   GET  /billing/mock/checkout?t=…             the plan, its seats and price, and three buttons: Simulate: pays, declines, cancels
//   POST /billing/mock/checkout?t=…&outcome=…   pays: checkout.session.completed and customer.subscription.created,
//                                               each signed with the dev key and posted to POST /billing/webhook/mock
//                                               (the real route, so app_billing_apply writes the subscription), then
//                                               303 to the plan page, or, when the webhook didn't take an event (its
//                                               `conflict`, `stale`, … is still a 200), a page with its actual answer
//                                               (#929); each checkout pays a new subscription id; declines: the page again with the card declined
//                                               and nothing sent (as Stripe's hosted page keeps the person there);
//                                               cancels: 303 back with ?checkout=cancelled, nothing sent
//   GET  /billing/mock/portal?t=…               the subscription, cancel at the period end, and back; a grant
//                                               (manual: staff or invoice) shows its invoices only, no cancel (#941)
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

/** The webhook's answers that mean the event took effect (or was already in): anything else changed nothing. */
const TAKEN = new Set(['applied', 'recorded', 'duplicate', 'ignored']);

/** What the webhook made of one mock event: its `result` (or null for a non-200), and whether that took effect. */
export interface MockDelivery {
	taken: boolean;
	status: number;
	result: string | null;
}

/**
 * Post one event to the real webhook route, signed with the dev key, and read what it made of it (#929):
 * a `conflict`, `stale` or `unknown_account` is a 200 as Stripe needs it to be (a retry wouldn't change
 * it), but nothing was applied, so it isn't taken. Also the mock's seat change (provider.ts).
 */
export async function deliverMockEvent(event: Record<string, unknown>): Promise<MockDelivery> {
	const secret = process.env.BILLING_WEBHOOK_SECRET?.trim();
	if (!secret) return { taken: false, status: 0, result: null };
	const { body, signature } = signedDelivery(secret, event);
	const res = await billingWebhookRoutes.request('/webhook/mock', {
		method: 'POST',
		headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
		body
	});
	let result: string | null = null;
	try {
		const answer = (await res.json()) as { result?: unknown };
		if (typeof answer?.result === 'string') result = answer.result;
	} catch {
		// Not JSON: no result to show.
	}
	return { taken: res.status === 200 && result !== null && TAKEN.has(result), status: res.status, result };
}

/** What a result that changed nothing means, in the page's words. */
const RESULT_WORDS: Record<string, string> = {
	conflict: 'it conflicts with a subscription already recorded (for example one that has ended), so nothing changed',
	stale: 'it is older than the last event applied to this subscription, so it was skipped',
	unknown_account: 'the account it names doesn’t exist any more'
};

/** The page for an event the webhook didn't take: its actual answer, never "done" (#929). */
const failed = (c: Context, back: string, d?: MockDelivery) => {
	const said = d?.result
		? `<p class="err" data-mock-error data-mock-result="${esc(d.result)}">The webhook answered <code>${esc(d.result)}</code>: ${esc(RESULT_WORDS[d.result] ?? 'nothing changed')}. The backend log says more.</p>`
		: `<p class="err" data-mock-error>The webhook refused the event${d?.status ? ` (HTTP ${d.status})` : ''}; the backend log says why.</p>`;
	const answered = d?.status === 200;
	return c.html(page(answered ? 'Nothing changed' : 'Something went wrong', `${said}\n${backLink(back)}`), answered ? 409 : 502);
};

const tokenQs = (c: Context) => `t=${encodeURIComponent(tokenOf(c))}`;

function checkoutPage(c: Context, s: Extract<MockSession, { kind: 'checkout' }>, declined: boolean): string {
	const qs = tokenQs(c);
	const per = s.interval === 'year' ? 'a year' : 'a month';
	const seats = s.seats ?? 1;
	const extra = seats - (s.seatsIncluded ?? 1);
	const seatLine =
		(s.seatsIncluded ?? 1) > 1 || extra > 0
			? `\n<p data-mock-seats="${seats}">${seats} editor seats${extra > 0 ? `: ${s.seatsIncluded} included and ${extra} extra at ${esc(money(s.extraSeatMinor ?? 0, s.currency))} each` : ', all included'}.</p>`
			: '';
	return page(
		`Subscribe to ${s.planName}`,
		`<p data-mock-price>${esc(money(s.amountMinor, s.currency))} ${per}.</p>${seatLine}
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
		for (const event of paidEvents(s)) {
			const d = await deliverMockEvent(event);
			if (!d.taken) return failed(c, pageOf(s.successUrl), d);
		}
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
			: sub.provider === 'manual'
				? // A staff or invoice grant (#941): nothing the mock bills, so nothing to cancel; the portal shows invoices only.
					`<p data-mock-subscription="manual">Your ${esc(planName)} plan is paid by invoice and runs to ${esc(sub.periodEnd.slice(0, 10))}. Nothing renews here and there is nothing to cancel: ask the operator to change it.</p>
<h2>Invoices</h2>
<p data-mock-invoices>Invoices for this plan come by email with your purchase order number (simulated: the mock sends none).</p>`
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
		// A grant (manual) is shown with its invoices only: a hand-made cancel of one is refused, as the page offers none.
		if (s.subscription?.provider === 'manual') return c.json({ error: 'nothing to cancel here' }, 409);
		const event = cancelAtPeriodEndEvent(s);
		if (event) {
			const d = await deliverMockEvent(event);
			if (!d.taken) return failed(c, s.returnUrl, d);
		}
		logEvent('info', { event: 'billing_mock_portal', action: 'cancel' });
		c.header('Cache-Control', 'no-store');
		return c.redirect(s.returnUrl, 303);
	});
