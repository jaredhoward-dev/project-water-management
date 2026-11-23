// Billing routes, Phase 1 (issue #641, docs/billing.md, docs/api.md § Billing):
// read-only, shadow mode. GET /billing/plans is public (the pricing page);
// GET /account/plan is the signed-in person's own account; GET /teams/:id/plan
// is the team's, for its admins only (404 to anyone else, a team member,
// viewer or farmer included, so the route doesn't say the team exists).
// Every read goes through the 323_billing definer functions; the plan JSON is
// theirs, passed through with "enforced" (BILLING_ENFORCED) added.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withoutUser, withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { UUID } from '../projects/access.js';
import { accountPlan, listPlans, myAccountId, teamAccountId } from './entitlements.js';

/** GET /billing/plans: anyone, signed in or not. The plans are public prices, not anyone's data. */
export const billingPublicRoutes = new Hono().get('/plans', async (c) => {
	const plans = await withoutUser((db) => listPlans(db));
	return c.json({ plans });
});

/** GET /account/plan: the caller's own billing account, created on first ask (app_my_billing_account). */
export const accountPlanRoutes = new Hono<AuthEnv>().get('/plan', async (c) => {
	const plan = await withUser(c.get('userId'), async (db) => accountPlan(db, await myAccountId(db)));
	// app_my_billing_account always gives the caller an account they may read: a null here is a broken function, not a 404.
	if (!plan) throw new Error('app_account_plan answered nothing for the caller’s own account');
	c.header('Cache-Control', 'no-store');
	return c.json(plan);
});

/** GET /teams/:id/plan: the team's billing account, for its admins only. */
export const teamPlanRoutes = new Hono<AuthEnv>().get('/:id/plan', async (c) => {
	const id = c.req.param('id');
	if (!UUID.test(id)) throw new ApiError(404, 'not found');
	const plan = await withUser(c.get('userId'), async (db) => accountPlan(db, await teamAccountId(db, id)));
	if (!plan) throw new ApiError(404, 'not found');
	c.header('Cache-Control', 'no-store');
	return c.json(plan);
});
