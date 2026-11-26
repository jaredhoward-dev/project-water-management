import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { safeError, stackFrames } from '../logging/safeError.js';
import { logEvent } from '../logging/logEvent.js';

/**
 * Throw from a handler to return `{ error }` with a status. `error` is
 * English for developers and integrators; the translated pages never show it.
 */
export class ApiError extends Error {
	/** A stable, farmer-visible error code (ERROR_CODES); the translated pages word it from their catalogue. */
	code?: ErrorCode;
	/** Values the client's wording fills in (e.g. `seconds` for a lockout). */
	params?: Record<string, number | string>;

	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}

	/**
	 * An error a farmer can meet on a translated page (the sign-in, account,
	 * alert and farm pages): the response carries `code` (and `params`), which
	 * the client words in the reader's language (docs/api.md § Errors). The
	 * English `message` stays for everyone else. `details`: data the page shows
	 * as it is (the names in account_sole_holder), never words.
	 */
	static coded(status: ApiError['status'], code: ErrorCode, message: string, params?: Record<string, number | string>, details?: unknown): ApiError {
		const e = new ApiError(status, message, details);
		e.code = code;
		if (params) e.params = params;
		return e;
	}
}

/**
 * Every error code the API sends (docs/api.md § Errors). A code is a
 * contract: the frontend words each one (`CODES` in
 * frontend/src/lib/i18n/apiError.ts; apiError.test.ts), so rename none; add new ones.
 * Errors without a code are worded on the client by their status.
 */
export const ERROR_CODES = [
	'not_signed_in',
	'account_exists',
	'wrong_credentials',
	'email_unconfirmed',
	'signin_locked',
	'signup_throttled',
	'signup_closed',
	// Sign-up with an address on a disposable domain, with BILLING_ENFORCED on (auth/disposable.ts, #641 item 5).
	'signup_disposable',
	// Changing the email address (347, auth/email-change-routes.ts).
	'email_change_same',
	'email_change_disposable',
	'email_change_taken',
	'terms_not_accepted',
	'farm_notice_changed',
	'wrong_current_password',
	'password_changed_elsewhere',
	'link_invalid',
	'already_verified',
	'verification_sent_recently',
	'verification_limit',
	'invite_invalid',
	'note_farmer_own_farm',
	'note_farm_visibility',
	'note_author_only',
	'note_delete_denied',
	'note_comment_closed',
	'note_audience_denied',
	// A WUA viewer kept from registered volumes previewing a farm while a cap or full-allocation run is published (farms/view.ts, #523 I).
	'farm_preview_withheld',
	'unsubscribe_link_gone',
	'feedback_link_gone',
	'export_throttled',
	'alerts_resume_throttled',
	'body_refused',
	'run_unverified',
	'account_sole_holder',
	// DELETE /auth/me when the person's own paid plan couldn't be cancelled at the payment provider (auth/deleteAccount.ts).
	'account_plan_not_cancelled',
	// Two-step sign-in (issue #282, auth/mfa-routes.ts, auth/stepUp.ts).
	'mfa_code_wrong',
	'mfa_locked',
	'mfa_challenge_expired',
	'mfa_already_enrolled',
	'mfa_not_started',
	'mfa_not_enrolled',
	'mfa_required',
	'mfa_step_up',
	// Asked for a reset of a lost second factor too often today (205, auth/mfa-reset-routes.ts).
	'mfa_reset_limit',
	// A team admin tried to remove another admin's second factor (205, teams/mfa-reset-routes.ts): only a member below admin.
	'mfa_reset_admin',
	// Codes by email (206, auth/mfa-routes.ts): a send limit (params.seconds), and a send that failed.
	'mfa_email_wait',
	'mfa_email_failed',
	// A comment through a share link (166_public_participation, share/routes.ts): 10 an hour per account.
	'comment_throttled',
	// 402 (issue #641 Enforcement design, 334_team_seats): with BILLING_ENFORCED on, a change would give a Team account's
	// team more editors than its paid seats (adding or promoting a team member or admin, a project editor or owner,
	// accepting an invite, moving a project into the team). params { limit: paid seats, used: the seats in use with the
	// change, plan }. Only seat roles meet it, which farmers never hold, but accepting an invite on the translated
	// Invitations page (/account/invitations) words it from this code; the team and project member pages (workspace)
	// show the English text.
	'plan_limit'
] as const;

/**
 * Codes a translated page never meets (a machine client reads them, or the
 * English workspace, which shows the server's message as it is), so they
 * have no words in the frontend's `CODES` (docs/api.md § Errors). The same
 * contract: add new ones, rename none.
 *   render_token_refused: POST /auth/render-session refused the token (used,
 *     expired, or the requester lost access). The report renderer
 *     (reports/render.ts) treats only this as final; any other refusal (a
 *     WAF or CloudFront 403, a 429, a 5xx) is retried.
 *   pack_errata_since_draft: POST …/packs/:packId/issue refused a draft
 *     because an erratum found since it was drafted applies to its runs'
 *     engines (or their fits') and its manifest doesn't record it: draft the
 *     pack again (evidence/packs.ts).
 *   registration_not_checked: POST …/packs/:packId/issue refused a draft
 *     whose specialist signer's registration has no current check against
 *     the professional register (167_signers, signoffs/registrationCheck.ts);
 *     `details.signers` names them.
 *   mfa_fresh_code (401): a sign-off, or issuing or withdrawing a pack,
 *     needs a code from the authenticator within the last 10 minutes
 *     (auth/stepUp.ts requireFreshCode). The client asks for one, POSTs it to
 *     /auth/mfa/step-up and repeats the request (lib/api/client.ts).
 *   role_conflict: the change would make someone who edits the project
 *     (editor or owner, directly or through its team) also part of an
 *     applying party there: in a party, owning an application or shared
 *     one (163_licensing_authority's conflict guard). The member list and
 *     sharing are English workspace pages.
 *   job_collision (409): queueing a job met a pending one with the same
 *     dedupe key that the caller can't see (RLS), so there is no job to
 *     return (jobs/queue.ts JobCollisionError, issue #386). Only a
 *     contributor can meet it, and only if a kind they queue isn't keyed per
 *     user (jobs/contributorKinds.ts); their pages are English workspace pages.
 *   pack_volumes_withheld (403): a viewer the project doesn't let read each
 *     farm's registered volume (D3, allocations/viewerUnits.ts
 *     allocationUnitsHidden) asked for a pack's reproduction bundle, or for
 *     the manifest or PDF of a pack drafted before evidence-15, which name
 *     every farm with its volume, on a pack whose runs carry them (issue
 *     #523 G1; evidence/packs.ts). The pack page is an English workspace page.
 *   ewr_rule_scenario_only (400): a save of the project's own model (PUT
 *     …/model) or settings (PATCH /projects/:id) switched on a rule that keeps
 *     water for the EWR (a pass-inflow release without amounts, a unit's or
 *     an off-take's handsOffEwr, the drought restriction's ewrTrigger): in
 *     the baseline the EWR is assessed and reported, never applied, so they
 *     run only in a scenario (issue #523 B4; projects/ewrRules.ts).
 *     `details` is one line per rule. The forms are English workspace pages.
 *   allocation_series_withheld (403): such a viewer asked for a run's daily
 *     series worked out from a registered volume: an allocation series (a
 *     cap's room or what is left, a full allocation's factor), or any series,
 *     day or file of a unit a cap or full-allocation run bound to its volume
 *     (issue #523 finding I; runs/withheldSeries.ts). The run pages are
 *     English workspace pages; they don't ask for these (`withheldSeries`).
 *   yield_pattern_unit (400): POST …/yield with `params.patternNodeId`
 *     naming no hydrological unit of the run's or scenario's model (or one
 *     hidden from an applicant), or one with no irrigation demand to shape
 *     the draft (yield/store.ts checkPatternNode, checkPatternDemand). The
 *     Yield panel is an English workspace page.
 *   yield_no_dam (400): POST …/yield for a unit whose dam capacity is 0 in
 *     the run's or scenario's model: a firm yield always, a storage–yield
 *     curve without `params.maxCapacityM3` (yield/store.ts checkYieldNode).
 *   yield_no_inflow (400): POST …/yield for a dam nothing routes water into
 *     in that model (Runoff to dam and Upstream inflow to dam 0 %, no River
 *     to dam, no transfer in; engine damInflowRoutes): its yield is 0 at any
 *     size (yield/store.ts checkYieldNode).
 *   publication_changed (409): POST …/publication or PATCH
 *     …/publication/:pubId whose `basedOn` is no longer the current
 *     publication as it stands (another editor published or changed it
 *     since the form was opened), or a PATCH of a superseded publication
 *     (publish/publish.ts, issues #863 and #885: compared by `revision`). The Publication panel is an English
 *     workspace page: it reloads the publication and says why.
 *   assistant_* (issue #610, assistant/routes.ts; docs/api.md § Assistant):
 *     the assistant panel is an English workspace page. Before a stream:
 *     assistant_off (404, ASSISTANT_PROVIDER is off), assistant_rate_limited
 *     (429 + Retry-After, the person's messages this hour; params.seconds),
 *     assistant_budget_spent (429 + Retry-After, the project's tokens this
 *     month), assistant_user_budget_spent (the person's this month, across
 *     projects) and assistant_total_budget_spent (the deployment's this
 *     month; each params.seconds and params.scope); with BILLING_ENFORCED
 *     on, the dollar caps (336_assistant_dollar_caps, assistant/dollarCaps.ts;
 *     429 + Retry-After, params.seconds and params.resetsAt):
 *     assistant_daily_cap (a Free person's SAST day), assistant_trial_cap and
 *     assistant_trial_daily_cap (a reverse trial's $2 in all and $1 a day, 342), assistant_monthly_cap
 *     (the account's month), assistant_member_cap (a Team member's share of
 *     it) and assistant_free_pool_spent (the shared Free pool);
 *     assistant_input_too_large
 *     (413, the newest message alone passes ASSISTANT_MAX_INPUT_CHARS). As a
 *     stream's `error` event (assistant/orchestrator.ts TURN_ERRORS):
 *     assistant_hop_limit, assistant_output_limit, assistant_turn_limit,
 *     assistant_timeout, assistant_provider_error.
 *   billing_* (issue #641 Phase 3, billing/provider.ts; docs/api.md § Billing):
 *     POST …/plan/checkout and …/plan/portal, from the English Plan and usage
 *     page. billing_unavailable (409, the manual provider or none: no online
 *     billing), billing_provider_error (503, the provider failed or isn't set
 *     up; never its text), billing_no_customer (409, the portal for an
 *     account that never checked out), billing_grant_seats (409, POST
 *     /teams/:id/plan/seats on a staff grant, whose seats change by a new
 *     grant; Phase 5).
 *   team_plan_not_cancelled (503): DELETE /teams/:id when the team's paid
 *     plan couldn't be ended at the payment provider (it failed, no provider
 *     that can cancel is set up, or a checkout landed a subscription the
 *     cancel didn't reach); nothing was deleted (billing/cancelOnDelete.ts
 *     TeamPlanNotCancelledError). The team page is an English workspace
 *     page and shows the message, which says to try again.
 *   email_unverified, email_disposable (403): Free's verified-email gate
 *     (billing/emailGate.ts, 343_free_email_gate; only with BILLING_ENFORCED
 *     on): the caller, on a project whose account is on Free, hasn't verified
 *     their email, or it is on a disposable domain (auth/disposable.ts). Sent
 *     by POST …/assistant/messages and by a feed save that switches a feed on
 *     (POST …/feeds, PATCH …/feeds/:feedId). The workspace's assistant and
 *     feeds panels word them, with a Resend for the first.
 *   team_move_admin (403): PATCH /projects/:id { teamId } taking a project
 *     out of its team, or into a different one, by someone who isn't an
 *     admin of the team it is in (a plain member, or an outside person the
 *     team made a direct owner; issue #900, 392_team_project_move_admin).
 *     The project settings page is an English workspace page.
 *   paired_baseline_mismatch (400): POST …/runs/:runId/uncertainty with a
 *     `baselineId` whose ensemble was stored on another engine, when the
 *     baseline run's inputs, which the job re-runs its kept sets on (issue
 *     #897), no longer match that ensemble (the engine's pairedRefusal: another
 *     runoff model, period, or a monthly PE under a varied pan coefficient).
 *     The workspace's uncertainty panel shows the message.
 *   seats_below_editors (409): POST /teams/:id/plan/seats, with
 *     BILLING_ENFORCED on, asking for fewer seats than the team's editors in
 *     use (app_team_seats_in_use); params { seats, editors }. The English
 *     team Plan and usage page shows the message.
 */
export const MACHINE_ERROR_CODES = [
	'render_token_refused',
	'pack_errata_since_draft',
	'registration_not_checked',
	'mfa_fresh_code',
	'role_conflict',
	'job_collision',
	'pack_volumes_withheld',
	'ewr_rule_scenario_only',
	'allocation_series_withheld',
	'yield_pattern_unit',
	'yield_no_dam',
	'yield_no_inflow',
	'publication_changed',
	'assistant_off',
	'assistant_rate_limited',
	'assistant_budget_spent',
	'assistant_user_budget_spent',
	'assistant_total_budget_spent',
	'assistant_daily_cap',
	'assistant_trial_cap',
	'assistant_trial_daily_cap',
	'assistant_monthly_cap',
	'assistant_member_cap',
	'assistant_free_pool_spent',
	'assistant_input_too_large',
	'assistant_hop_limit',
	'assistant_output_limit',
	'assistant_turn_limit',
	'assistant_timeout',
	'assistant_provider_error',
	'billing_unavailable',
	'billing_provider_error',
	'billing_no_customer',
	'billing_grant_seats',
	'team_plan_not_cancelled',
	'email_unverified',
	'email_disposable',
	'team_move_admin',
	'paired_baseline_mismatch',
	'seats_below_editors'
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number] | (typeof MACHINE_ERROR_CODES)[number];

export const notFound = () => new ApiError(404, 'not found');

/**
 * A write on the row a route already authorised must change it. Zero rows
 * means RLS, the second layer behind the route's role check, refused it:
 * answer what a non-member gets rather than a silent success (issue #56).
 */
export function mustChange(r: { rowCount: number | null }): void {
	if (!r.rowCount) throw notFound();
}

/** 409 role_conflict's words (163_licensing_authority): fixed, never the database's text. */
export const ROLE_CONFLICT_MESSAGE =
	'someone who edits this project (an editor or owner, directly or through its team) can’t also be in an applying party, own an application or be shared one here: take them out of the party, or keep them below editor';

/** 402 plan_limit's words for Team seats (334_team_seats): fixed, never the database's text. */
export const PLAN_LIMIT_SEATS_MESSAGE =
	'every editor seat on this team’s plan is in use: a team admin can add seats on the team’s Plan and usage page, or make someone a viewer';

/** 402 plan_limit's words for Free's one live catchment (338_live_catchments): fixed, never the database's text. */
export const PLAN_LIMIT_LIVE_MESSAGE =
	'Free runs one catchment live (data feeds, automatic runs, alerts and published farm views): switch them off in the other catchment, or compare plans';

/**
 * The plan_limit refusal's numbers, from the DETAIL 334's and 338's guards
 * write ({"limit", "used", "plan"}, and 338's "key": "live_catchments"): only
 * a whole number for each count, a known plan code and a known limit key
 * pass, so nothing else from the database reaches the response.
 */
export function planLimitParams(err: unknown): Record<string, number | string> {
	const out: Record<string, number | string> = {};
	let detail: unknown;
	try {
		detail = JSON.parse(String((err as { detail?: unknown }).detail ?? ''));
	} catch {
		return out;
	}
	if (!detail || typeof detail !== 'object') return out;
	const d = detail as Record<string, unknown>;
	for (const k of ['limit', 'used'] as const) if (Number.isSafeInteger(d[k]) && (d[k] as number) >= 0) out[k] = d[k] as number;
	if (d.plan === 'free' || d.plan === 'pro' || d.plan === 'team') out.plan = d.plan;
	if (d.key === 'live_catchments') out.key = d.key;
	return out;
}

/** Postgres SQLSTATE codes we translate into client errors. */
const PG_UNIQUE = '23505';
const PG_FK = '23503';
const PG_CHECK = '23514';
const PG_EXCLUSION = '23P01';
const PG_RLS = '42501';

export function handleError(err: unknown, c: Context) {
	if (err instanceof ApiError) {
		return c.json(
			{
				error: err.message,
				...(err.code ? { code: err.code } : {}),
				...(err.params ? { params: err.params } : {}),
				...(err.details ? { details: err.details } : {})
			},
			err.status
		);
	}
	if (err instanceof ZodError) {
		return c.json({ error: 'invalid request', details: err.issues }, 400);
	}
	// A body streamed without Content-Length that outgrows a bodyLimit fails
	// the handler's read; the bodyLimit middleware then answers with its own
	// 413 message. Not a server fault, so it isn't logged.
	if (err instanceof Error && err.name === 'BodyLimitError') {
		return c.json({ error: 'request too large' }, 413);
	}
	if (err instanceof HTTPException) {
		return c.json({ error: err.message || 'error' }, err.status);
	}
	const code = (err as { code?: string }).code;
	if (code === PG_UNIQUE) return c.json({ error: 'already exists' }, 409);
	// Never echo raw database error text — it leaks schema details.
	if (code === PG_FK) return c.json({ error: 'references something that does not exist in this project' }, 400);
	// 163's conflict guard names itself, so the client can say what to change.
	if (code === PG_CHECK && (err as { constraint?: string }).constraint === 'role_conflict')
		return c.json({ error: ROLE_CONFLICT_MESSAGE, code: 'role_conflict' satisfies ErrorCode }, 409);
	// 334's seat guard and 338's live-catchment guard name themselves: 402 plan_limit, with only the numbers they put in their DETAIL.
	if (code === PG_CHECK && (err as { constraint?: string }).constraint === 'plan_limit') {
		const params = planLimitParams(err);
		const error = params.key === 'live_catchments' ? PLAN_LIMIT_LIVE_MESSAGE : PLAN_LIMIT_SEATS_MESSAGE;
		return c.json({ error, code: 'plan_limit' satisfies ErrorCode, params }, 402);
	}
	if (code === PG_CHECK) return c.json({ error: 'violates a data rule' }, 409);
	// An exclusion constraint (e.g. one issued evidence pack per application, 112): a conflict with another row.
	if (code === PG_EXCLUSION) return c.json({ error: 'conflicts with another record' }, 409);
	// RLS WITH CHECK failures surface as insufficient_privilege.
	if (code === PG_RLS) return c.json({ error: 'forbidden' }, 403);
	// Answering 500 means the Lambda invocation itself succeeds, so the
	// function's `Errors` metric never counts it. Log one structured line
	// instead, which the unhandled-error alarm counts (infra/alarms.tf,
	// `unhandled_error`). Only the error's name, code and stack frames and the
	// route's pattern go in (safeError): never its message, which for a pg
	// error can carry row values and for anything else user input, and never
	// the concrete path, which can hold a token.
	logEvent('error', {
		event: 'unhandled_error',
		method: c.req.method,
		route: c.req.routePath,
		...safeError(err),
		at: stackFrames(err)
	});
	return c.json({ error: 'Internal server error' }, 500);
}
