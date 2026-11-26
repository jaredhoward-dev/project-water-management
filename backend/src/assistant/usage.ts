// What the assistant may spend (issue #610; 262_assistant_usage.sql,
// docs/security.md § Assistant): token budgets per UTC month, in weighted
// tokens (input + 5 × output, config.ts weightedTokens), per project
// (cfg.tokensPerMonth), per person across projects (cfg.tokensPerUserMonth)
// and for the whole deployment (cfg.tokensTotalPerMonth), and a message cap
// per person per hour across projects (cfg.messagesPerHour). A turn is begun
// before its stream starts, in the transaction that checked the caller's
// role: counted as a message, and its budget reserved
// (264_assistant_reservation: what no cap is passed by, however many turns
// run at once). It is charged its tokens after it ends, whatever the
// outcome, which settles the reservation; one never settled (the Lambda
// died) is charged in full once it expires. The charge also records the
// turn's cost in micro-USD (pricing.ts, 324_assistant_turn_cost), which the
// dollar caps read (336_assistant_dollar_caps), refusing only with
// BILLING_ENFORCED on (issue #641; dollarCaps.ts).
import type { Context } from 'hono';
import { withUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { RESERVATION_MARGIN_SECONDS, type AssistantConfig } from './config.js';
import { dayResetsAt, DOLLAR_REFUSAL, isDollarOutcome, poolAlarmShare, type DollarOutcome } from './dollarCaps.js';
import type { AssistantDayMeter } from './types.js';

/** When this UTC month's budget starts again: the first instant of next month, ISO. */
export function monthResetsAt(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** This UTC month's weighted tokens (config.ts weightedTokens): the project's, the caller's across projects, the deployment's. */
export interface MonthUsed {
	project: number;
	user: number;
	total: number;
}

/** Which cap a budget is: the project's month, the person's, or the deployment's. */
export type BudgetScope = 'project' | 'user' | 'total';

/**
 * The cap nearest its end, for the panel's "share of the budget left": the one
 * with the fewest tokens left (ties go to the widest, which is the one that
 * refuses first, as app_assistant_begin checks the deployment's first).
 */
export function bindingBudget(
	cfg: Pick<AssistantConfig, 'tokensPerMonth' | 'tokensPerUserMonth' | 'tokensTotalPerMonth'>,
	used: MonthUsed
): { scope: BudgetScope; tokensPerMonth: number; tokensUsed: number } {
	const caps: { scope: BudgetScope; tokensPerMonth: number; tokensUsed: number }[] = [
		{ scope: 'total', tokensPerMonth: cfg.tokensTotalPerMonth, tokensUsed: used.total },
		{ scope: 'user', tokensPerMonth: cfg.tokensPerUserMonth, tokensUsed: used.user },
		{ scope: 'project', tokensPerMonth: cfg.tokensPerMonth, tokensUsed: used.project }
	];
	return caps.reduce((a, b) => (b.tokensPerMonth - b.tokensUsed < a.tokensPerMonth - a.tokensUsed ? b : a));
}

type UsedRow = { project_used: string | null; user_used: string | null; total_used: string | null };
const monthUsed = (r: UsedRow | undefined): MonthUsed => ({ project: Number(r?.project_used ?? 0), user: Number(r?.user_used ?? 0), total: Number(r?.total_used ?? 0) });

/** This month's tokens (the caller is a viewer or above; the route checked). */
export async function tokensUsed(db: Db, projectId: string): Promise<MonthUsed> {
	const { rows } = await db.query<UsedRow>('SELECT project_used, user_used, total_used FROM app_assistant_used($1)', [projectId]);
	return monthUsed(rows[0]);
}

type DayMeterRow = {
	kind: 'free' | 'trial';
	usd_micros_per_day: string;
	usd_micros_left: string;
	messages_left: number | null;
	trial_usd_micros_left: string | null;
	median_turn_usd_micros: string | null;
};
const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Today's assistant for the caller on the project's billing account, for the panel's "questions left today" meter
 * (350_assistant_day_meter, its median the caller's own since 351; docs/billing.md § Assistant dollar caps): null
 * unless billing is enforced and the account is capped by the day (Free, or a reverse trial). Read in the caller's
 * transaction (withUser); the function answers nothing to anyone below a viewer.
 */
export async function dayMeter(
	db: Db,
	projectId: string,
	cfg: Pick<AssistantConfig, 'freeUsdMicrosPerDay' | 'freeMessagesPerDay'>,
	now = new Date()
): Promise<AssistantDayMeter | null> {
	const { rows } = await db.query<DayMeterRow>(
		`SELECT kind, usd_micros_per_day, usd_micros_left, messages_left, trial_usd_micros_left, median_turn_usd_micros
		 FROM app_assistant_day_meter($1, $2, $3)`,
		[projectId, cfg.freeUsdMicrosPerDay, cfg.freeMessagesPerDay]
	);
	const r = rows[0];
	if (!r) return null;
	return {
		kind: r.kind,
		usdMicrosPerDay: Number(r.usd_micros_per_day),
		usdMicrosLeft: Number(r.usd_micros_left),
		messagesLeft: r.messages_left,
		trialUsdMicrosLeft: numOrNull(r.trial_usd_micros_left),
		medianTurnUsdMicros: numOrNull(r.median_turn_usd_micros),
		resetsAt: dayResetsAt(now)
	};
}

/** The refusal for a spent month, by the cap that refused. */
const SPENT: Record<BudgetScope, { code: 'assistant_budget_spent' | 'assistant_user_budget_spent' | 'assistant_total_budget_spent'; what: string }> = {
	project: { code: 'assistant_budget_spent', what: 'This project has used its assistant budget for the month' },
	user: { code: 'assistant_user_budget_spent', what: 'You have used your assistant budget for the month, across your projects' },
	total: { code: 'assistant_total_budget_spent', what: 'The assistant has used this server’s budget for the month' }
};

/** Seconds past the turn's deadline a reservation lasts (config.ts, where the turn's own seconds are capped by it). */
export { RESERVATION_MARGIN_SECONDS } from './config.js';

/** A begun turn: this month's tokens before it, and the budget reserved for it. */
export interface BegunTurn {
	used: MonthUsed;
	/** The reservation app_assistant_charge settles (chargeTurn). */
	reservationId: string;
	/** Weighted tokens the turn may spend (runTurn's budget). */
	budget: number;
}

/**
 * Begin one turn as the transaction's user: counts the message and reserves
 * the turn's budget (the least of cfg.maxTurnTokens and what each monthly cap
 * has left), or throws 429 with Retry-After (`assistant_rate_limited` past
 * the hourly cap; once a month has less than `minTokens` left
 * `assistant_total_budget_spent` for the deployment's,
 * `assistant_user_budget_spent` for the person's, `assistant_budget_spent`
 * for the project's; nothing counted). `minTokens` is the turn's floor
 * (orchestrator.ts turnFloor), no more than cfg.maxTurnTokens.
 *
 * The dollar caps (336_assistant_dollar_caps, dollarCaps.ts): the turn's
 * budget × `usdMicrosPerToken` (pricing.ts usdMicrosPerWeightedToken; null
 * with no price) is reserved in dollars too. With BILLING_ENFORCED on, the
 * account's month (`assistant_monthly_cap`), a Team member's share
 * (`assistant_member_cap`), a Free person's day (`assistant_daily_cap`) and
 * the paced Free pool (`assistant_free_pool_spent`) refuse too, and cut the
 * budget to what they have left; off, they only record. The day's and the
 * month's 429 carry `params.plan` (the refusing account's plan code) for the
 * panel's Compare plans, shown on Free only.
 */
/** The plan code of the project's billing account as the caller may read it (app_account_plan); null when they may not. */
async function accountPlanCode(db: Db, projectId: string): Promise<string | null> {
	const { rows } = await db.query<{ code: string | null }>(
		`SELECT app_account_plan(p.billing_account_id) -> 'plan' ->> 'code' AS code FROM project p WHERE p.id = $1`,
		[projectId]
	);
	return rows[0]?.code ?? null;
}

export async function beginTurn(
	c: Context,
	db: Db,
	projectId: string,
	cfg: Pick<
		AssistantConfig,
		| 'tokensPerMonth'
		| 'tokensPerUserMonth'
		| 'tokensTotalPerMonth'
		| 'messagesPerHour'
		| 'maxTurnTokens'
		| 'turnSeconds'
		| 'freeUsdMicrosPerDay'
		| 'freeMessagesPerDay'
		| 'poolUsdMicrosPerMonth'
	>,
	minTokens: number,
	usdMicrosPerToken: number | null = null
): Promise<BegunTurn> {
	const { rows } = await db.query<
		UsedRow & {
			outcome: 'ok' | 'rate' | 'budget' | 'user_budget' | 'total_budget' | DollarOutcome;
			wait_seconds: number;
			reservation_id: string | null;
			budget: string | null;
			pool_used_usd_micros: string | null;
			pool_usd_micros: string | null;
		}
	>(
		`SELECT outcome, wait_seconds, project_used, user_used, total_used, reservation_id, budget, pool_used_usd_micros, pool_usd_micros
		 FROM app_assistant_begin($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		[
			projectId,
			cfg.tokensPerMonth,
			cfg.messagesPerHour,
			cfg.tokensPerUserMonth,
			cfg.tokensTotalPerMonth,
			cfg.maxTurnTokens,
			Math.ceil(minTokens),
			cfg.turnSeconds + RESERVATION_MARGIN_SECONDS,
			usdMicrosPerToken,
			cfg.freeUsdMicrosPerDay,
			cfg.freeMessagesPerDay,
			cfg.poolUsdMicrosPerMonth
		]
	);
	const r = rows[0]!;
	if (r.outcome === 'rate') {
		c.header('Retry-After', String(r.wait_seconds));
		throw ApiError.coded(429, 'assistant_rate_limited', `You have sent ${cfg.messagesPerHour} messages to the assistant in the last hour; try again in ${Math.ceil(r.wait_seconds / 60)} min.`, {
			seconds: r.wait_seconds
		});
	}
	if (isDollarOutcome(r.outcome)) {
		const refusal = DOLLAR_REFUSAL[r.outcome];
		const resetsAt = new Date(Date.now() + r.wait_seconds * 1000).toISOString();
		c.header('Retry-After', String(r.wait_seconds));
		// The plan whose allowance refused (`params.plan`), so the panel can offer Compare plans on Free's day and month
		// only: the day refuses a Free person only; the month is the project's account's, read as app_account_plan
		// answers the caller (null, so left out, when they may not read that account). The member share and the pool
		// never upsell, so they carry none; nor do a reverse trial's caps (342): the person is on Pro already.
		const plan = r.outcome === 'day' ? 'free' : r.outcome === 'month' ? await accountPlanCode(db, projectId) : null;
		throw ApiError.coded(429, refusal.code, refusal.message(resetsAt), { seconds: r.wait_seconds, resetsAt, ...(plan ? { plan } : {}) });
	}
	if (r.outcome !== 'ok') {
		const scope: BudgetScope = r.outcome === 'budget' ? 'project' : r.outcome === 'user_budget' ? 'user' : 'total';
		c.header('Retry-After', String(r.wait_seconds));
		throw ApiError.coded(429, SPENT[scope].code, `${SPENT[scope].what}; it starts again on ${monthResetsAt().slice(0, 10)}.`, { seconds: r.wait_seconds, scope });
	}
	// The Free pool's 50% and 80% alarms (infra/alarms.tf) count this line; amounts only, nobody named.
	const share = poolAlarmShare(r.pool_used_usd_micros === null ? null : Number(r.pool_used_usd_micros), r.pool_usd_micros === null ? null : Number(r.pool_usd_micros));
	if (share !== null) {
		logEvent('warn', { event: 'assistant_free_pool', share, usedUsdMicros: Number(r.pool_used_usd_micros), poolUsdMicros: Number(r.pool_usd_micros) });
	}
	return { used: monthUsed(r), reservationId: r.reservation_id!, budget: Number(r.budget) };
}

/** What a charge records beside the tokens: the cache's part of the input, and the cost (pricing.ts; null: unpriced). */
export interface TurnCost {
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsdMicros: number | null;
}

/** A charge with no cache tokens and no price, counted in unpriced_turns (324). */
export const UNPRICED: TurnCost = { cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicros: null };

/**
 * Charge a finished turn's tokens and cost to the caller's row and settle its
 * reservation (null: a charge with no reservation, this month). A reservation
 * id no row has (it expired and was charged in full already) charges again,
 * counted twice by design (264), and logs `assistant_charge_no_reservation`
 * with the id and the tokens only (388). Returns this
 * month's tokens after it, or null if the charge failed (logged as
 * `assistant_charge_failed`, not thrown: the answer is already sent; the
 * assistant's charge-failed alarm reads that line, infra/alarms.tf). A
 * reservation left by a failed charge is charged in full once it expires.
 */
export async function chargeTurn(
	userId: string,
	projectId: string,
	reservationId: string | null,
	inputTokens: number,
	outputTokens: number,
	cost: TurnCost = UNPRICED
): Promise<MonthUsed | null> {
	const count = (n: number) => Math.max(0, Math.round(n) || 0);
	const input = count(inputTokens);
	// The cache's part never more than the input (the function refuses it), reads first.
	const cacheRead = Math.min(input, count(cost.cacheReadTokens));
	const cacheWrite = Math.min(input - cacheRead, count(cost.cacheWriteTokens));
	try {
		return await withUser(userId, async (db) => {
			const { rows } = await db.query<UsedRow & { reservation_missing: boolean | null }>(
				'SELECT project_used, user_used, total_used, reservation_missing FROM app_assistant_charge($1, $2, $3, $4, $5, $6, $7)',
				[projectId, reservationId, input, count(outputTokens), cacheRead, cacheWrite, cost.costUsdMicros === null ? null : count(cost.costUsdMicros)]
			);
			if (rows[0]?.reservation_missing) {
				// Counted twice, never too little (264): the expired reservation was charged in full already.
				logEvent('warn', { event: 'assistant_charge_no_reservation', reservationId, inputTokens: input, outputTokens: count(outputTokens) });
			}
			return monthUsed(rows[0]);
		});
	} catch (err) {
		logEvent('error', { event: 'assistant_charge_failed', ...safeError(err) });
		return null;
	}
}
