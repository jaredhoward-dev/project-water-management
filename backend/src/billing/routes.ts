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
import { billingEnforced } from './enforced.js';
import { accountPlan, listPlans, myAccountId, teamAccountId } from './entitlements.js';
import type { PublicPlan } from './entitlements.js';
import { BILLING_INTERVALS, BillingGrantSeatsError, BillingUnavailableError, billingProvider, checkoutPlanOf, MAX_CHECKOUT_SEATS, PURCHASABLE, type CheckoutPlan, type LiveSubscription, type ReturnUrls } from './provider.js';

/** GET /billing/plans: anyone, signed in or not. The plans are public prices, not anyone's data. */
export const billingPublicRoutes = new Hono().get('/plans', async (c) => {
	const plans = await withoutUser((db) => listPlans(db));
	return c.json({ plans });
});

// PURCHASABLE and checkoutPlanOf live in provider.ts (the staff tool's invoice, billing/invoice.ts, prices with them too).
export { checkoutPlanOf, PURCHASABLE } from './provider.js';

const checkoutBody = z
	.object({ plan: z.string().min(1).max(32), interval: z.enum(BILLING_INTERVALS), seats: z.number().int().min(1).max(MAX_CHECKOUT_SEATS).optional() })
	.strict();

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
type AccountPlanJson = { plan?: { code?: string; name?: string; limits?: { seats_included?: unknown } }; team?: { editorCount?: number } | null; subscription?: (Omit<LiveSubscription, 'planCode'> & { status: string }) | null };

/** The account's kind, plan and customer, read as the caller; null when they may not (app_account_plan's own check). */
async function accountState(db: Db, accountId: string | null): Promise<AccountState | null> {
	const plan = await accountPlan(db, accountId);
	if (!plan || !accountId) return null;
	const { rows } = await db.query<{ ref: string | null }>('SELECT app_billing_customer_ref($1) AS ref', [accountId]);
	const kind = (plan.account as { kind?: string } | undefined)?.kind === 'team' ? 'team' : 'user';
	return { id: accountId, kind, customerRef: rows[0]?.ref ?? null, plan: plan as AccountPlanJson };
}

/**
 * Whether the account's live subscription stops a checkout: any does but the
 * reverse trial (342: provider `manual`, status `trialing`), which the paid
 * plan replaces when its webhook lands (344's app_billing_apply ends the trial).
 * A staff or invoice grant (`manual`, `active`) and a paid plan still do.
 */
export function checkoutBlockedBy(sub: { status: string } | null | undefined, liveProvider: string | null | undefined): boolean {
	if (!sub) return false;
	return !(sub.status === 'trialing' && liveProvider === 'manual');
}

async function checkout(c: Context<AuthEnv>, resolve: (db: Db) => Promise<string | null>, pagePath: string) {
	// Access first, so a stranger meets 404 whatever the provider.
	const state = await withUser(c.get('userId'), async (db) => {
		const s = await accountState(db, await resolve(db));
		if (!s?.plan.subscription) return s && { ...s, liveProvider: null };
		const { rows } = await db.query<{ ref: { provider?: string } | null }>('SELECT app_billing_live_subscription_ref($1) AS ref', [s.id]);
		return { ...s, liveProvider: rows[0]?.ref?.provider ?? null };
	});
	if (!state) throw new ApiError(404, 'not found');
	const provider = billingProvider();
	if (!provider || provider.name === 'manual') throw new BillingUnavailableError();
	const body = checkoutBody.parse(await readJson(c));
	if (PURCHASABLE[state.kind] !== body.plan) throw new ApiError(400, `this account can subscribe to the ${PURCHASABLE[state.kind]} plan only`);
	if (checkoutBlockedBy(state.plan.subscription, state.liveProvider)) throw new ApiError(409, 'this account already has a subscription; change it from Manage billing');
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
	// No fields, but a body sent is still read and checked (http/body.ts), as checkout's is: a hostile one is a 400, before any provider call.
	z.object({}).strict().parse((await readJson(c, { optional: true })) ?? {});
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
				seatsIncluded: includedSeats(state.plan),
				interval: sub.interval ?? null
			}
		: null;
	const result = await provider.createPortal({ id: state.id, customerRef: state.customerRef }, live, returnUrls(c, pagePath, false));
	logEvent('info', { event: 'billing_portal', provider: provider.name });
	c.header('Cache-Control', 'no-store');
	return c.json({ url: result.url });
}

const seatsBody = z.object({ seats: z.number().int().min(1).max(MAX_CHECKOUT_SEATS) }).strict();

const LIVE = new Set(['trialing', 'active', 'past_due']);

/**
 * POST /teams/:id/plan/seats (Phase 5, docs/billing.md § Changing a Team's seats):
 * the team's editor seats on its live Team subscription. 404 to anyone but the
 * team's admins, before any provider call; 400 for a body other than
 * `{ seats: <whole number 1…50> }`; 409 without a live Team subscription,
 * for a grant (its seats change by a new grant) or a provider that takes no
 * changes (manual); 400 for seats outside the included ones…50 or equal to the
 * current count. The provider changes the subscription; the seats come back
 * through the webhook (app_billing_apply), never written here.
 */
async function changeSeats(c: Context<AuthEnv>, teamId: string) {
	if (!UUID.test(teamId)) throw new ApiError(404, 'not found');
	const found = await withUser(c.get('userId'), async (db) => {
		const accountId = await teamAccountId(db, teamId);
		const state = await accountState(db, accountId);
		if (!state || !accountId) return null;
		const { rows } = await db.query<{ ref: { provider?: string; externalRef?: string | null } | null }>('SELECT app_billing_live_subscription_ref($1) AS ref', [accountId]);
		return { state, ref: rows[0]?.ref ?? null };
	});
	if (!found) throw new ApiError(404, 'not found');
	const { state, ref } = found;
	// The body next, so a bad one is 400 whatever the subscription (the mass-assignment sweep's "refused past validation").
	const body = seatsBody.parse(await readJson(c));
	const sub = state.plan.subscription;
	if (!sub || !LIVE.has(sub.status) || state.plan.plan?.code !== 'team' || !ref) throw new ApiError(409, 'only a live Team subscription has seats to change');
	if (ref.provider === 'manual') throw new BillingGrantSeatsError();
	const provider = billingProvider();
	if (!provider || provider.name === 'manual') throw new BillingUnavailableError();
	// A subscription another provider holds (a mock one after switching to Stripe): this provider can't change it.
	if (ref.provider !== provider.name || !ref.externalRef || !sub.periodStart || !sub.periodEnd) throw new ApiError(409, 'this subscription can’t be changed here; ask the operator');
	const plans = await withoutUser((db) => listPlans(db));
	const teamPlan = plans.find((p) => p.code === 'team');
	if (!teamPlan) throw new ApiError(409, 'the Team plan isn’t on sale');
	const plan = checkoutPlanOf(teamPlan);
	if (plan.extraSeatMonthlyMinor === null && plan.extraSeatAnnualMinor === null) throw new ApiError(400, `the ${plan.name} plan sells no extra seats`);
	if (body.seats < plan.seatsIncluded) throw new ApiError(400, `the ${plan.name} plan includes ${plan.seatsIncluded} seats; choose at least that many`);
	if (body.seats === sub.seats) throw new ApiError(400, `the team already has ${sub.seats} seats`);
	// Fewer seats than the editors in use: the seat guard (334) never takes a seat from someone holding one, so without
	// this a team could buy seats, fill them and drop back while keeping every editor. Enforced only; shadow mode counts.
	const editors = state.plan.team?.editorCount;
	if (billingEnforced() && typeof editors === 'number' && body.seats < editors)
		throw ApiError.coded(409, 'seats_below_editors', `this team has ${editors} editors: make some of them viewers before going below ${editors} seats`, { seats: body.seats, editors });
	await provider.changeSeats({
		accountId: state.id,
		externalRef: ref.externalRef,
		plan,
		subscription: {
			planCode: 'team',
			status: sub.status,
			periodStart: sub.periodStart,
			periodEnd: sub.periodEnd,
			cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
			seats: sub.seats,
			seatsIncluded: plan.seatsIncluded
		},
		seats: body.seats
	});
	logEvent('info', { event: 'billing_seats', provider: provider.name, from: sub.seats, to: body.seats });
	c.header('Cache-Control', 'no-store');
	return c.json({ seats: body.seats });
}

const assistantShareBody = z.object({ pct: z.number().int().min(1).max(100) }).strict();

/**
 * POST /teams/:id/plan/assistant-share (docs/billing.md § Assistant dollar caps):
 * the share of the team's monthly assistant dollars one member may use
 * (billing_account.assistant_member_max_pct, 336; default 50%). For the team's
 * admins only, through app_team_set_assistant_share (339), which answers NULL to
 * anyone else: 404, so the route doesn't say the team exists. 400 for a body
 * other than `{ pct: <whole number 1…100> }`. Answers `{ pct }`, the share now
 * stored; it binds from the member's next turn (refused past only when billing
 * is enforced).
 */
async function setAssistantShare(c: Context<AuthEnv>, teamId: string) {
	if (!UUID.test(teamId)) throw new ApiError(404, 'not found');
	// Access first, so a stranger meets 404 whatever the body.
	const isAdmin = await withUser(c.get('userId'), async (db) => (await teamAccountId(db, teamId)) !== null);
	if (!isAdmin) throw new ApiError(404, 'not found');
	const body = assistantShareBody.parse(await readJson(c));
	const pct = await withUser(c.get('userId'), async (db) => {
		const { rows } = await db.query<{ pct: number | null }>('SELECT app_team_set_assistant_share($1, $2) AS pct', [teamId, body.pct]);
		return rows[0]?.pct ?? null;
	});
	// No longer an admin between the two transactions.
	if (pct === null) throw new ApiError(404, 'not found');
	logEvent('info', { event: 'billing_assistant_share', pct });
	c.header('Cache-Control', 'no-store');
	return c.json({ pct });
}

const keepBody = z.object({ projectId: z.string().regex(UUID) }).strict();

/** The account's live catchments for the Plan page's picker (345 app_billing_live_catchments); null when the caller may not read the account. */
async function liveCatchments(db: Db, accountId: string | null): Promise<Record<string, unknown> | null> {
	if (!accountId) return null;
	const { rows } = await db.query<{ list: Record<string, unknown> | null }>('SELECT app_billing_live_catchments($1) AS list', [accountId]);
	return rows[0]?.list ?? null;
}

/** GET …/plan/live-catchments: 404 to anyone but the account's person or a team admin. */
async function getLiveCatchments(c: Context<AuthEnv>, resolve: (db: Db) => Promise<string | null>) {
	const list = await withUser(c.get('userId'), async (db) => liveCatchments(db, await resolve(db)));
	if (!list) throw new ApiError(404, 'not found');
	c.header('Cache-Control', 'no-store');
	return c.json(list);
}

/**
 * POST …/plan/keep (docs/billing.md § Choosing the catchment to keep): the
 * live catchment that stays live past Free's limit, `{ projectId }`. 404 to
 * anyone but the account's person or a team admin, before the body is read;
 * 400 for any other body; 404 too when the project isn't one of the account's
 * live catchments (the same answer, so it says nothing about the project).
 * The pause moves at once (341); answers the list as it now stands.
 */
async function keepCatchment(c: Context<AuthEnv>, resolve: (db: Db) => Promise<string | null>) {
	// Access first, so a stranger meets 404 whatever the body.
	const accountId = await withUser(c.get('userId'), async (db) => {
		const id = await resolve(db);
		return id && (await liveCatchments(db, id)) ? id : null;
	});
	if (!accountId) throw new ApiError(404, 'not found');
	const body = keepBody.parse(await readJson(c));
	const list = await withUser(c.get('userId'), async (db) => {
		const { rows } = await db.query<{ ok: boolean }>('SELECT app_billing_keep_live($1, $2) AS ok', [accountId, body.projectId]);
		return rows[0]?.ok ? liveCatchments(db, accountId) : null;
	});
	if (!list) throw new ApiError(404, 'not found');
	logEvent('info', { event: 'billing_keep_catchment' });
	c.header('Cache-Control', 'no-store');
	return c.json(list);
}

/** GET /account/plan: the caller's own billing account, created on first ask (app_my_billing_account); POST …/checkout, …/portal and …/keep, and GET …/live-catchments, for it. */
export const accountPlanRoutes = new Hono<AuthEnv>()
	.post('/plan/checkout', (c) => checkout(c, myAccountId, '/account/plan'))
	.post('/plan/portal', (c) => portal(c, myAccountId, '/account/plan'))
	.post('/plan/keep', (c) => keepCatchment(c, myAccountId))
	.get('/plan/live-catchments', (c) => getLiveCatchments(c, myAccountId))
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

/** GET /teams/:id/plan: the team's billing account, for its admins only; POST …/checkout, …/portal, …/seats, …/assistant-share and …/keep, and GET …/live-catchments, for it. */
export const teamPlanRoutes = new Hono<AuthEnv>()
	.post('/:id/plan/checkout', async (c) => checkout(c, teamResolver(c.req.param('id')), `/teams/${c.req.param('id')}/plan`))
	.post('/:id/plan/portal', async (c) => portal(c, teamResolver(c.req.param('id')), `/teams/${c.req.param('id')}/plan`))
	.post('/:id/plan/seats', async (c) => changeSeats(c, c.req.param('id')))
	.post('/:id/plan/assistant-share', async (c) => setAssistantShare(c, c.req.param('id')))
	.post('/:id/plan/keep', async (c) => keepCatchment(c, teamResolver(c.req.param('id'))))
	.get('/:id/plan/live-catchments', async (c) => getLiveCatchments(c, teamResolver(c.req.param('id'))))
	.get('/:id/plan', async (c) => {
		const id = c.req.param('id');
		if (!UUID.test(id)) throw new ApiError(404, 'not found');
		const plan = await withUser(c.get('userId'), async (db) => accountPlan(db, await teamAccountId(db, id)));
		if (!plan) throw new ApiError(404, 'not found');
		c.header('Cache-Control', 'no-store');
		return c.json(plan);
	});
