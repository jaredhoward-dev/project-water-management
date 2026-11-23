// Billing routes, Phase 1 (issue #641, docs/billing.md, docs/api.md § Billing):
// read-only, shadow mode. GET /billing/plans is public (the pricing page);
// GET /account/plan is the signed-in person's own account; GET /teams/:id/plan
// is the team's, for its admins only (404 to anyone else, a team member,
// viewer or farmer included, so the route doesn't say the team exists).
// Every read goes through the 323_billing definer functions; the plan JSON is
// theirs, passed through with "enforced" (BILLING_ENFORCED) added.
//
// Phase 3 (docs/billing.md § Checkout and portal): POST …/plan/checkout and
// …/plan/portal on the same two accounts, with the same access (the person's
// own; a team's for its admins, 404 to anyone else). Each answers
// `{ url }`, where the page sends the person: the provider's hosted page
// (Stripe) or the mock's local one. The provider call runs outside any
// transaction; a customer the provider made is stored after it, through
// app_billing_set_customer_ref (328).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withoutUser, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { UUID } from '../projects/access.js';
import { accountPlan, listPlans, myAccountId, teamAccountId } from './entitlements.js';
import type { PublicPlan } from './entitlements.js';
import { BILLING_INTERVALS, BillingUnavailableError, billingProvider, MAX_CHECKOUT_SEATS, type CheckoutPlan, type LiveSubscription, type ReturnUrls } from './provider.js';

/** GET /billing/plans: anyone, signed in or not. The plans are public prices, not anyone's data. */
export const billingPublicRoutes = new Hono().get('/plans', async (c) => {
	const plans = await withoutUser((db) => listPlans(db));
	return c.json({ plans });
});

/** Which plan each kind of account can buy: Pro is a person's, Team a team's (docs/billing.md § Who the plan belongs to). */
export const PURCHASABLE: Record<'user' | 'team', string> = { user: 'pro', team: 'team' };

const checkoutBody = z
	.object({ plan: z.string().min(1).max(32), interval: z.enum(BILLING_INTERVALS), seats: z.number().int().min(1).max(MAX_CHECKOUT_SEATS).optional() })
	.strict();

const minor = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** A public plan as checkout prices it: its included seats (limits.seats_included) and extra-seat prices (features.extra_seat_*_minor). */
export function checkoutPlanOf(p: PublicPlan): CheckoutPlan {
	const included = p.limits.seats_included;
	return {
		code: p.code,
		name: p.name,
		priceMonthlyMinor: p.priceMonthlyMinor,
		priceAnnualMinor: p.priceAnnualMinor,
		currency: p.currency,
		seatsIncluded: typeof included === 'number' && Number.isInteger(included) && included >= 1 ? included : 1,
		extraSeatMonthlyMinor: minor(p.features.extra_seat_monthly_minor),
		extraSeatAnnualMinor: minor(p.features.extra_seat_annual_minor)
	};
}

/**
 * The seats a checkout sells: the plan's included ones when the body names none; else
 * at least those and at most MAX_CHECKOUT_SEATS, and only on a plan that prices extra
 * seats at this interval (Team). A 400 otherwise.
 */
export function checkoutSeats(plan: CheckoutPlan, interval: 'month' | 'year', seats: number | undefined): number {
	if (seats === undefined || seats === plan.seatsIncluded) return plan.seatsIncluded;
	const extraPrice = interval === 'year' ? plan.extraSeatAnnualMinor : plan.extraSeatMonthlyMinor;
	if (extraPrice === null) throw new ApiError(400, `the ${plan.name} plan has ${plan.seatsIncluded} seat${plan.seatsIncluded === 1 ? '' : 's'} and sells no extra ones`);
	if (seats < plan.seatsIncluded) throw new ApiError(400, `the ${plan.name} plan includes ${plan.seatsIncluded} seats; choose at least that many`);
	return seats;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** The plan page to come back to (SITE_URL, as the emails' links), and this API's own origin for the mock's pages. */
function returnUrls(c: Context, path: string, checkout: boolean): ReturnUrls {
	const page = `${trimSlash(process.env.SITE_URL || 'http://localhost:7777')}${path}`;
	return {
		successUrl: checkout ? `${page}?checkout=done` : page,
		cancelUrl: checkout ? `${page}?checkout=cancelled` : page,
		apiBase: new URL(c.req.url).origin
	};
}

interface AccountState {
	id: string;
	kind: 'user' | 'team';
	customerRef: string | null;
	plan: AccountPlanJson;
}
type AccountPlanJson = { plan?: { code?: string; name?: string; limits?: { seats_included?: unknown } }; subscription?: (Omit<LiveSubscription, 'planCode'> & { status: string }) | null };

/** The account's kind, plan and customer, read as the caller; null when they may not (app_account_plan's own check). */
async function accountState(db: Db, accountId: string | null): Promise<AccountState | null> {
	const plan = await accountPlan(db, accountId);
	if (!plan || !accountId) return null;
	const { rows } = await db.query<{ ref: string | null }>('SELECT app_billing_customer_ref($1) AS ref', [accountId]);
	const kind = (plan.account as { kind?: string } | undefined)?.kind === 'team' ? 'team' : 'user';
	return { id: accountId, kind, customerRef: rows[0]?.ref ?? null, plan: plan as AccountPlanJson };
}

async function checkout(c: Context<AuthEnv>, resolve: (db: Db) => Promise<string | null>, pagePath: string) {
	// Access first, so a stranger meets 404 whatever the provider.
	const state = await withUser(c.get('userId'), async (db) => accountState(db, await resolve(db)));
	if (!state) throw new ApiError(404, 'not found');
	const provider = billingProvider();
	if (!provider || provider.name === 'manual') throw new BillingUnavailableError();
	const body = checkoutBody.parse(await readJson(c));
	if (PURCHASABLE[state.kind] !== body.plan) throw new ApiError(400, `this account can subscribe to the ${PURCHASABLE[state.kind]} plan only`);
	if (state.plan.subscription) throw new ApiError(409, 'this account already has a subscription; change it from Manage billing');
	const plans = await withoutUser((db) => listPlans(db));
	const found = plans.find((p) => p.code === body.plan);
	if (!found) throw new ApiError(400, 'no such plan');
	const plan = checkoutPlanOf(found);
	const seats = checkoutSeats(plan, body.interval, body.seats);
	const result = await provider.createCheckout({ id: state.id, customerRef: state.customerRef }, plan, body.interval, returnUrls(c, pagePath, true), seats);
	if (result.newCustomerRef) {
		const stored = await withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<{ ref: string | null }>('SELECT app_billing_set_customer_ref($1, $2) AS ref', [state.id, result.newCustomerRef]);
			return rows[0]?.ref ?? null;
		});
		// Another checkout stored a different customer first: this session's customer isn't the account's, so don't send the person there.
		if (stored !== result.newCustomerRef) throw new ApiError(409, 'another checkout for this account started at the same time; try again');
	}
	logEvent('info', { event: 'billing_checkout', provider: provider.name, plan: body.plan, interval: body.interval, seats });
	c.header('Cache-Control', 'no-store');
	return c.json({ url: result.url });
}

const includedSeats = (p: AccountPlanJson): number => {
	const n = p.plan?.limits?.seats_included;
	return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1;
};

async function portal(c: Context<AuthEnv>, resolve: (db: Db) => Promise<string | null>, pagePath: string) {
	// Access first, so a stranger meets 404 whatever the provider.
	const state = await withUser(c.get('userId'), async (db) => accountState(db, await resolve(db)));
	if (!state) throw new ApiError(404, 'not found');
	const provider = billingProvider();
	if (!provider || provider.name === 'manual') throw new BillingUnavailableError();
	const sub = state.plan.subscription;
	const live: LiveSubscription | null = sub
		? {
				planCode: String(state.plan.plan?.code ?? 'free'),
				planName: state.plan.plan?.name,
				status: sub.status,
				periodStart: sub.periodStart,
				periodEnd: sub.periodEnd,
				cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
				seats: sub.seats,
				seatsIncluded: includedSeats(state.plan)
			}
		: null;
	const result = await provider.createPortal({ id: state.id, customerRef: state.customerRef }, live, returnUrls(c, pagePath, false));
	logEvent('info', { event: 'billing_portal', provider: provider.name });
	c.header('Cache-Control', 'no-store');
	return c.json({ url: result.url });
}

/** GET /account/plan: the caller's own billing account, created on first ask (app_my_billing_account); POST …/checkout and …/portal for it. */
export const accountPlanRoutes = new Hono<AuthEnv>()
	.post('/plan/checkout', (c) => checkout(c, myAccountId, '/account/plan'))
	.post('/plan/portal', (c) => portal(c, myAccountId, '/account/plan'))
	.get('/plan', async (c) => {
		const plan = await withUser(c.get('userId'), async (db) => accountPlan(db, await myAccountId(db)));
		// app_my_billing_account always gives the caller an account they may read: a null here is a broken function, not a 404.
		if (!plan) throw new Error('app_account_plan answered nothing for the caller’s own account');
		c.header('Cache-Control', 'no-store');
		return c.json(plan);
	});

const teamResolver = (id: string) => {
	if (!UUID.test(id)) throw new ApiError(404, 'not found');
	return (db: Db) => teamAccountId(db, id);
};

/** GET /teams/:id/plan: the team's billing account, for its admins only; POST …/checkout and …/portal for it. */
export const teamPlanRoutes = new Hono<AuthEnv>()
	.post('/:id/plan/checkout', async (c) => checkout(c, teamResolver(c.req.param('id')), `/teams/${c.req.param('id')}/plan`))
	.post('/:id/plan/portal', async (c) => portal(c, teamResolver(c.req.param('id')), `/teams/${c.req.param('id')}/plan`))
	.get('/:id/plan', async (c) => {
		const id = c.req.param('id');
		if (!UUID.test(id)) throw new ApiError(404, 'not found');
		const plan = await withUser(c.get('userId'), async (db) => accountPlan(db, await teamAccountId(db, id)));
		if (!plan) throw new ApiError(404, 'not found');
		c.header('Cache-Control', 'no-store');
		return c.json(plan);
	});
