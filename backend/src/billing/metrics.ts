// The Phase 1 metrics and the staff abuse report (issue #641, "Phase 1 metrics
// and thresholds", "Free tier and abuse"; docs/billing.md § Metrics and the
// abuse report). Pure maths over the rows 325_billing_metrics's owner-only
// functions return; backend/scripts/billing-report.ts gathers and prints.
//
// The output holds counts and aggregates, account and person ids only where a
// signal needs a follow-up, and email domains only for a domain cluster.
// Addresses appear only when the caller asks (`showEmails`).

export interface AccountRow {
	accountId: string;
	kind: 'user' | 'team';
	planCode: string;
	startedAt: Date;
	catchments: number;
	runs: number;
	reports: number;
	assistantUsdMicros: number;
	unpricedTurns: number;
	lastSpendAt: Date | null;
	/** Its live catchments today (338's app_live_catchments_in_use: a feed, an alert, automatic runs or a publication on). */
	liveCatchments: number;
}

export interface PersonRow {
	userId: string;
	email: string;
	createdAt: Date;
	verified: boolean;
	firstRunAt: Date | null;
	inMonth: boolean;
	/** The sign-up's day in Africa/Johannesburg, YYYY-MM-DD. */
	signupDay: string;
}

/** A plan's limits as 323 stores them (snake_case; null is unlimited). */
export type PlanLimits = Record<string, number | null>;

const DAY_MS = 86_400_000;
/** Near a limit: at least this share of it (the 80% soft warning of "Enforcement design"). */
export const NEAR_SHARE = 0.8;
/** "5+ new accounts a week in one address or canonical cluster" (escalation a). */
export const CLUSTER_WEEK = 5;
/** Accounts younger than this count as new for the Free spend share. */
export const NEW_ACCOUNT_DAYS = 7;
/** Activation window: a run within this many days of signing up. */
export const ACTIVATION_DAYS = 7;

/** Mail providers whose clusters are expected at scale; flagged, not hidden. */
const COMMON_PROVIDERS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com']);

/** The ASCII whitespace canonical_email's btrim strips (space, \t, \n, \v, \f, \r), at either end. */
const EDGE_SPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
/** A-Z to a-z and nothing else, as canonical_email's translate(). */
const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * The address one allowance is keyed to: lower-cased, a `+tag` removed, and
 * for Gmail the dots too (googlemail.com is gmail.com). Issue #641, "One
 * allowance per person".
 *
 * A local part that starts with `+` (`+tag@example.org`) is kept whole (issue
 * #893): there is no base address before the tag, so dropping it would leave
 * `@example.org` and fold every such address at a domain, different
 * mailboxes of different people, into one trial and one abuse cluster.
 * Subaddressing needs a base (Gmail's, Outlook's and Fastmail's usernames
 * can't start with `+`), so such an address is its own mailbox, as a
 * catch-all domain's `a@` and `b@` are, which no canonical form can join.
 *
 * Lower-casing and trimming are ASCII only (issue #914): A-Z to a-z, and the
 * six ASCII whitespace characters off the ends, so the SQL twin
 * canonical_email (396, 397) gives the same string byte for byte. Unicode
 * case rules differ between JavaScript's toLowerCase() and Postgres's
 * locale-bound lower() (`İ`), and String.trim() strips Unicode spaces btrim
 * keeps; a non-ASCII letter stays as written on both sides.
 */
export function canonicalEmail(email: string): string {
	const lower = asciiLower(email.replace(EDGE_SPACE, ''));
	const at = lower.lastIndexOf('@');
	if (at < 1) return lower;
	let local = lower.slice(0, at);
	let domain = lower.slice(at + 1);
	const plus = local.indexOf('+');
	if (plus > 0) local = local.slice(0, plus); // not at 0: a leading `+` has no base address (above)
	if (domain === 'googlemail.com') domain = 'gmail.com';
	if (domain === 'gmail.com') local = local.replaceAll('.', '');
	return `${local}@${domain}`;
}

export const emailDomain = (email: string): string => canonicalEmail(email).split('@')[1] ?? '';

/** The nearest-rank percentile (p in 0–1) of the values; null for none. */
export function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil(p * sorted.length));
	return sorted[rank - 1]!;
}

export const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** Active in the month: a run, a server report or assistant use on any of its projects. */
export const isActive = (a: AccountRow): boolean => a.runs > 0 || a.reports > 0 || a.assistantUsdMicros > 0 || a.unpricedTurns > 0;

export interface Activation {
	/** Verified sign-ups in the month at least 7 days old now. */
	cohort: number;
	activated: number;
	share: number | null;
	/** Verified sign-ups in the month under 7 days old: their window is still open, so they're left out. */
	pending: number;
	unverified: number;
}

/** Verified sign-ups of the month with a model run within 7 days of signing up. */
export function activation(people: PersonRow[], now: Date): Activation {
	const month = people.filter((p) => p.inMonth);
	const verified = month.filter((p) => p.verified);
	const done = verified.filter((p) => now.getTime() - p.createdAt.getTime() >= ACTIVATION_DAYS * DAY_MS);
	const activated = done.filter((p) => p.firstRunAt !== null && p.firstRunAt.getTime() - p.createdAt.getTime() <= ACTIVATION_DAYS * DAY_MS).length;
	return { cohort: done.length, activated, share: share(activated, done.length), pending: verified.length - done.length, unverified: month.length - verified.length };
}

export interface LimitShare {
	limit: 'reports_per_month' | 'assistant_usd_micros_per_month' | 'catchments' | 'live_catchments';
	/** The Free plan's limit; null: Free has none, so nothing is near it. */
	value: number | null;
	near: number;
	at: number;
	nearShare: number | null;
	atShare: number | null;
}

const used = (a: AccountRow, limit: LimitShare['limit']): number =>
	limit === 'reports_per_month'
		? a.reports
		: limit === 'catchments'
			? a.catchments
			: limit === 'live_catchments'
				? a.liveCatchments
				: a.assistantUsdMicros;

/** Of the month's active Free accounts, how many are near (≥ 80%, below 100%) or at (≥ 100%) each Free limit. */
export function freeLimitShares(accounts: AccountRow[], freeLimits: PlanLimits): { active: number; limits: LimitShare[] } {
	const active = accounts.filter((a) => a.planCode === 'free' && isActive(a));
	const limits = (['reports_per_month', 'assistant_usd_micros_per_month', 'catchments', 'live_catchments'] as const).map((limit): LimitShare => {
		const value = freeLimits[limit] ?? null;
		if (value === null || value <= 0) return { limit, value: null, near: 0, at: 0, nearShare: null, atShare: null };
		const at = active.filter((a) => used(a, limit) >= value).length;
		const near = active.filter((a) => used(a, limit) >= NEAR_SHARE * value && used(a, limit) < value).length;
		return { limit, value, near, at, nearShare: share(near, active.length), atShare: share(at, active.length) };
	});
	return { active: active.length, limits };
}

export interface SpendByPlan {
	plan: string;
	/** Accounts with any assistant spend in the month. */
	spenders: number;
	p50UsdMicros: number | null;
	p90UsdMicros: number | null;
	totalUsdMicros: number;
	/** Turns with no price: the totals are a floor when this isn't 0. */
	unpricedTurns: number;
}

/** Assistant spend per account in the month, p50 and p90 over the accounts that spent, per plan. */
export function spendByPlan(accounts: AccountRow[]): SpendByPlan[] {
	const plans = [...new Set(accounts.map((a) => a.planCode))].sort();
	return plans.map((plan) => {
		const rows = accounts.filter((a) => a.planCode === plan && (a.assistantUsdMicros > 0 || a.unpricedTurns > 0));
		const spend = rows.map((a) => a.assistantUsdMicros);
		return {
			plan,
			spenders: rows.length,
			p50UsdMicros: percentile(spend, 0.5),
			p90UsdMicros: percentile(spend, 0.9),
			totalUsdMicros: spend.reduce((s, v) => s + v, 0),
			unpricedTurns: rows.reduce((s, a) => s + a.unpricedTurns, 0)
		};
	});
}

/**
 * The share of the month's Free assistant spend by accounts younger than 7
 * days. assistant_usage keeps one row per person, project and month, so the
 * day of each turn isn't known: an account counts as new when its latest
 * spend of the month came less than 7 days after it started. That makes the
 * share an upper bound.
 */
export function newAccountFreeSpend(accounts: AccountRow[]): { totalUsdMicros: number; newUsdMicros: number; share: number | null } {
	const free = accounts.filter((a) => a.planCode === 'free' && a.assistantUsdMicros > 0);
	const isNew = (a: AccountRow) => a.lastSpendAt !== null && a.lastSpendAt.getTime() - a.startedAt.getTime() < NEW_ACCOUNT_DAYS * DAY_MS;
	const total = free.reduce((s, a) => s + a.assistantUsdMicros, 0);
	const fresh = free.filter(isNew).reduce((s, a) => s + a.assistantUsdMicros, 0);
	return { totalUsdMicros: total, newUsdMicros: fresh, share: share(fresh, total) };
}

/** The heaviest Free spenders of the month, by assistant spend (ids for a follow-up). */
export function heaviestFree(accounts: AccountRow[], n = 5): { accountId: string; usdMicros: number }[] {
	return accounts
		.filter((a) => a.planCode === 'free' && a.assistantUsdMicros > 0)
		.sort((a, b) => b.assistantUsdMicros - a.assistantUsdMicros || a.accountId.localeCompare(b.accountId))
		.slice(0, n)
		.map((a) => ({ accountId: a.accountId, usdMicros: a.assistantUsdMicros }));
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The most sign-ups in any 7 consecutive days among these days (YYYY-MM-DD), and the window's first day. */
export function busiestWeek(days: string[]): { count: number; from: string | null } {
	const sorted = [...days].sort();
	let best = { count: 0, from: null as string | null };
	for (let i = 0, j = 0; i < sorted.length; i++) {
		const end = addDays(sorted[i]!, -6);
		while (sorted[j]! < end) j++;
		if (i - j + 1 > best.count) best = { count: i - j + 1, from: sorted[j]! };
	}
	return best;
}

export interface DomainCluster {
	domain: string;
	signups: number;
	busiestWeek: number;
	weekFrom: string | null;
	commonProvider: boolean;
}

export interface CanonicalCluster {
	/** Printed only with --show-emails. */
	canonical: string;
	userIds: string[];
	inMonth: number;
	emails: string[];
}

export interface AbuseReport {
	signupsPerDay: { day: string; signups: number }[];
	/** Domains with 5+ sign-ups in some 7 days of the month (escalation a's trigger). */
	domainClusters: DomainCluster[];
	/** Canonical addresses with more than one account, ever; at least one signed up this month. */
	canonicalClusters: CanonicalCluster[];
}

export function abuseReport(people: PersonRow[]): AbuseReport {
	const month = people.filter((p) => p.inMonth);
	const perDay = new Map<string, number>();
	for (const p of month) perDay.set(p.signupDay, (perDay.get(p.signupDay) ?? 0) + 1);
	const signupsPerDay = [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, signups]) => ({ day, signups }));

	const byDomain = new Map<string, string[]>();
	for (const p of month) {
		const d = emailDomain(p.email);
		byDomain.set(d, [...(byDomain.get(d) ?? []), p.signupDay]);
	}
	const domainClusters = [...byDomain]
		.map(([domain, days]): DomainCluster => {
			const week = busiestWeek(days);
			return { domain, signups: days.length, busiestWeek: week.count, weekFrom: week.from, commonProvider: COMMON_PROVIDERS.has(domain) };
		})
		.filter((c) => c.busiestWeek >= CLUSTER_WEEK)
		.sort((a, b) => b.busiestWeek - a.busiestWeek || a.domain.localeCompare(b.domain));

	const byCanonical = new Map<string, PersonRow[]>();
	for (const p of people) {
		const c = canonicalEmail(p.email);
		byCanonical.set(c, [...(byCanonical.get(c) ?? []), p]);
	}
	const canonicalClusters = [...byCanonical]
		.filter(([, ps]) => ps.length > 1 && ps.some((p) => p.inMonth))
		.map(([canonical, ps]) => {
			const sorted = [...ps].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
			return { canonical, userIds: sorted.map((p) => p.userId), inMonth: ps.filter((p) => p.inMonth).length, emails: sorted.map((p) => p.email) };
		})
		.sort((a, b) => b.userIds.length - a.userIds.length || a.canonical.localeCompare(b.canonical));

	return { signupsPerDay, domainClusters, canonicalClusters };
}

/** One code and feature's refusals by Free's verified-email gate in the month (348 email_gate_refusal, summed by SAST day). */
export interface GateRefusalRow {
	code: 'email_unverified' | 'email_disposable';
	feature: 'assistant' | 'feeds';
	refusals: number;
}

export interface GateRefusals {
	/** "Disposable-domain rejections" (#641): refusals of an address on a disposable domain. */
	disposable: { assistant: number; feeds: number; total: number };
	unverified: { assistant: number; feeds: number; total: number };
}

/**
 * The month's refusals by the verified-email gate, per code and feature.
 * Counted only while BILLING_ENFORCED is on (the gate is off otherwise), and
 * only since 348: a zero before then is no data, not no refusals.
 */
export function gateRefusals(rows: GateRefusalRow[]): GateRefusals {
	const sum = (code: GateRefusalRow['code'], feature?: GateRefusalRow['feature']) =>
		rows.filter((r) => r.code === code && (feature === undefined || r.feature === feature)).reduce((s, r) => s + r.refusals, 0);
	const of = (code: GateRefusalRow['code']) => ({ assistant: sum(code, 'assistant'), feeds: sum(code, 'feeds'), total: sum(code) });
	return { disposable: of('email_disposable'), unverified: of('email_unverified') };
}

/** One reverse trial (342) started in the month: its billing_grant_log 'grant' by 'reverse trial', and the account's first paid plan from then on. */
export interface ReverseTrialRow {
	startedAt: Date;
	/**
	 * The account's first paid plan at or after the trial's start, or null: a
	 * subscription from a payment provider (Stripe, or the local mock) that
	 * isn't itself a trial, or a paid B2B invoice's grant (billing_grant_log
	 * 'grant' by 'invoice', 335). Staff grants are not paid and don't count.
	 */
	firstPaidAt: Date | null;
}

/** Days after a reverse trial's start within which a paid plan counts as converted. */
export const TRIAL_CONVERSION_DAYS = 30;

export interface ReverseTrialConversion {
	/** Trials started in the month whose 30 days have passed. */
	cohort: number;
	/** Of the cohort, accounts that started paying within 30 days of the trial's start. */
	paid: number;
	share: number | null;
	/** Trials started in the month whose 30 days are still open: left out of the share. */
	pending: number;
	/** Of the pending, those already paying. */
	pendingPaid: number;
}

/**
 * "Reverse trial → paid within 30 days" (#641): the reverse trials that began
 * in the report's SAST month, each an account (one trial per canonical email,
 * 342), and how many had a paid plan within 30 days of the trial's start
 * (start ≤ paid ≤ start + 30 days). A trial whose 30 days haven't passed is
 * pending, like activation's 7.
 */
export function reverseTrialToPaid(trials: ReverseTrialRow[], now: Date): ReverseTrialConversion {
	const window = TRIAL_CONVERSION_DAYS * DAY_MS;
	const paidIn = (t: ReverseTrialRow) => t.firstPaidAt !== null && t.firstPaidAt.getTime() - t.startedAt.getTime() <= window;
	const done = trials.filter((t) => now.getTime() - t.startedAt.getTime() >= window);
	const open = trials.filter((t) => now.getTime() - t.startedAt.getTime() < window);
	const paid = done.filter(paidIn).length;
	return { cohort: done.length, paid, share: share(paid, done.length), pending: open.length, pendingPaid: open.filter(paidIn).length };
}

/** The issue's metrics this data can't answer yet, and what each would need. Printed so nobody reads a gap as a zero. */
export const NOT_YET_MEASURABLE: { metric: string; needs: string }[] = [
	{ metric: 'Upgrade at the limit (checkout or trial within 7 days of a limit message)', needs: 'no checkout, trial or limit-message events are recorded (Phase 3)' },
	{ metric: 'Churn after the limit (inactive 30 days after hitting one)', needs: 'no record of when an account hit a limit' },
	{ metric: 'Share of active Free accounts at the assistant daily cap', needs: 'assistant_usage is monthly; there is no daily cap or daily record yet' },
	{ metric: 'Free pool burn by day of month', needs: 'assistant_usage is monthly; there is no pool or daily record yet' },
	{ metric: 'Paid AI: share of seats reaching $15', needs: 'spend is per project and person, not per paid seat; no one is on a paid plan in Phase 1' },
	{ metric: 'Sign-up throttle hits per address', needs: 'signup_throttle keeps only a hashed bucket for its hour (079)' },
	{ metric: 'Suspensions', needs: 'no suspend action yet' }
];

/**
 * Stripe stops redelivering a webhook event about 3 days after it was first sent (live mode). An orphan event row
 * (352) still `orphan_pending` past that will never be retried: the operator finishes its cancel and refund in
 * Stripe's dashboard (docs/deployment.md § Billing alarms).
 */
export const ORPHAN_RETRY_DAYS = 3;

/** An event row still `orphan_pending` (352): its subscription not yet cancelled and refunded. */
export interface OrphanPendingRow {
	provider: string;
	eventId: string;
	type: string;
	receivedAt: Date;
}

export interface StaleOrphan {
	provider: string;
	eventId: string;
	type: string;
	receivedAt: string;
	/** Whole days since it was first received. */
	days: number;
}

/** The pending orphans received more than ORPHAN_RETRY_DAYS before `now`, oldest first: the provider has stopped retrying them. */
export function staleOrphans(rows: OrphanPendingRow[], now: Date): StaleOrphan[] {
	return rows
		.filter((r) => now.getTime() - r.receivedAt.getTime() > ORPHAN_RETRY_DAYS * DAY_MS)
		.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
		.map((r) => ({
			provider: r.provider,
			eventId: r.eventId,
			type: r.type,
			receivedAt: r.receivedAt.toISOString(),
			days: Math.floor((now.getTime() - r.receivedAt.getTime()) / DAY_MS)
		}));
}

/**
 * A team paying for fewer editor seats than its editors in use (403, issue #926: a seat cut in the provider's
 * portal). Ids and numbers only: no names or addresses. `since` is when it was first recorded.
 */
export interface OverSeatsRow {
	accountId: string;
	teamId: string;
	seats: number;
	editors: number;
	since: string;
}

/**
 * An open price conflict (406, issue #928): a subscription event refused because its price wasn't the plan's. Not
 * held: the provider may be charging for a subscription the app never granted (refund it or grant the plan). Held: a
 * subscription whose price drifted keeps its last accepted state. Ids and amounts only, never a person.
 */
export interface OpenConflict {
	provider: string;
	accountId: string;
	externalRef: string;
	eventId: string;
	reason: string;
	planCode: string;
	interval: string | null;
	seats: number;
	amountMinor: number | null;
	currency: string | null;
	expectedMinor: number | null;
	held: boolean;
	createdAt: string;
}

export interface Report {
	month: string;
	generatedAt: string;
	accounts: number;
	activation: Activation;
	freeLimits: ReturnType<typeof freeLimitShares>;
	assistantSpend: SpendByPlan[];
	newAccountFreeSpend: ReturnType<typeof newAccountFreeSpend>;
	heaviestFree: ReturnType<typeof heaviestFree>;
	abuse: AbuseReport;
	gateRefusals: GateRefusals;
	reverseTrial: ReverseTrialConversion;
	/** Orphans the provider stopped retrying, whatever the month (352): the operator finishes each in the provider's dashboard. */
	staleOrphans: StaleOrphan[];
	/** Teams over their paid seats today, whatever the month (403), longest over first. */
	overSeats: OverSeatsRow[];
	/** Open price conflicts, whatever the month (406), oldest first. */
	billingConflicts: OpenConflict[];
	notYetMeasurable: typeof NOT_YET_MEASURABLE;
}

export function buildReport(
	month: string,
	now: Date,
	accounts: AccountRow[],
	people: PersonRow[],
	freeLimits: PlanLimits,
	refusals: GateRefusalRow[] = [],
	trials: ReverseTrialRow[] = [],
	orphans: OrphanPendingRow[] = [],
	overSeats: OverSeatsRow[] = [],
	conflicts: OpenConflict[] = []
): Report {
	return {
		month,
		generatedAt: now.toISOString(),
		accounts: accounts.length,
		activation: activation(people, now),
		freeLimits: freeLimitShares(accounts, freeLimits),
		assistantSpend: spendByPlan(accounts),
		newAccountFreeSpend: newAccountFreeSpend(accounts),
		heaviestFree: heaviestFree(accounts),
		abuse: abuseReport(people),
		gateRefusals: gateRefusals(refusals),
		reverseTrial: reverseTrialToPaid(trials, now),
		staleOrphans: staleOrphans(orphans, now),
		overSeats: [...overSeats].sort((a, b) => a.since.localeCompare(b.since) || a.accountId.localeCompare(b.accountId)),
		billingConflicts: conflicts,
		notYetMeasurable: NOT_YET_MEASURABLE
	};
}

/** The report without addresses: what prints unless the operator asks for --show-emails. */
export function redact(report: Report): Report {
	return {
		...report,
		abuse: { ...report.abuse, canonicalClusters: report.abuse.canonicalClusters.map((c) => ({ ...c, canonical: '(hidden)', emails: [] })) }
	};
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const usd = (micros: number | null) => (micros === null ? 'n/a' : `$${(micros / 1_000_000).toFixed(2)}`);

/** The report as text for the operator's terminal. */
export function formatReport(r: Report, showEmails: boolean): string {
	const out: string[] = [];
	out.push(`Billing metrics for ${r.month} (generated ${r.generatedAt}; ${r.accounts} billing accounts; plans as they are today)`, '');
	// First, since it is the one line that needs action now (352; docs/deployment.md § Billing alarms).
	if (r.staleOrphans.length === 0) out.push(`Orphaned subscriptions still pending past the provider's ${ORPHAN_RETRY_DAYS}-day retries: none`, '');
	else {
		out.push(`ACTION: ${r.staleOrphans.length} orphaned subscription(s) still pending past the provider's ${ORPHAN_RETRY_DAYS}-day retries; cancel and refund each in the provider's dashboard`);
		for (const o of r.staleOrphans) out.push(`  ${o.provider}  ${o.eventId}  ${o.type}  received ${o.receivedAt} (${o.days} days ago)`);
		out.push('');
	}
	// 406: a price conflict is an open action too (a charge with no plan, or a drifted price).
	if (r.billingConflicts.length === 0) out.push('Subscription price conflicts open: none', '');
	else {
		out.push(`ACTION: ${r.billingConflicts.length} subscription price conflict(s) open; refund or grant each one not held, check each held one in the provider's dashboard`);
		for (const c of r.billingConflicts) {
			const amount = c.amountMinor === null ? 'unpriced' : `${c.amountMinor} ${c.currency ?? '?'}`;
			out.push(
				`  ${c.provider}  ${c.externalRef}  account ${c.accountId}  ${c.reason}  ${c.planCode}/${c.interval ?? '?'} × ${c.seats}  ${amount} (expected ${c.expectedMinor ?? 'n/a'})  ${c.held ? 'held' : 'NOT HELD'}  event ${c.eventId}  ${c.createdAt}`
			);
		}
		out.push('');
	}
	// Teams over their paid seats (403): seats cut in the provider's portal; the seat guard refuses their new editors.
	if (r.overSeats.length === 0) out.push('Teams over their paid editor seats: none', '');
	else {
		out.push(`Teams over their paid editor seats: ${r.overSeats.length} (new editors refused until they add seats or make editors viewers)`);
		for (const o of r.overSeats) out.push(`  account ${o.accountId}  team ${o.teamId}  ${o.editors} editors on ${o.seats} seats  since ${o.since}`);
		out.push('');
	}
	const a = r.activation;
	out.push('Activation (verified sign-ups with a run within 7 days)');
	out.push(`  ${a.activated} of ${a.cohort} = ${pct(a.share)}  (threshold: < 30% → fix onboarding first)`);
	out.push(`  ${a.pending} verified sign-ups under 7 days old left out; ${a.unverified} unverified`, '');
	out.push(`Active Free accounts near (≥ 80%) / at each Free limit (${r.freeLimits.active} active: a run, report or assistant use this month)`);
	for (const l of r.freeLimits.limits) {
		const value = l.value === null ? 'no limit on Free' : l.limit === 'assistant_usd_micros_per_month' ? usd(l.value) : String(l.value);
		out.push(`  ${l.limit.padEnd(32)} ${value.padEnd(18)} near ${l.near} (${pct(l.nearShare)})  at ${l.at} (${pct(l.atShare)})`);
	}
	out.push('  thresholds: > 15% at reports → 10 a month; < 3% at the monthly assistant cap → room to raise');
	out.push('  catchments and live catchments are counted today; live: a feed, an alert, automatic runs or a publication on (338)', '');
	const rt = r.reverseTrial;
	out.push(`Reverse trial → paid within ${TRIAL_CONVERSION_DAYS} days (trials that began this month; paid: a card plan or a paid invoice)`);
	out.push(`  ${rt.paid} of ${rt.cohort} = ${pct(rt.share)}`);
	out.push(`  ${rt.pending} trials under ${TRIAL_CONVERSION_DAYS} days old left out (${rt.pendingPaid} of them paying already)`, '');
	out.push('Assistant spend per account (accounts that spent; UTC month)');
	for (const s of r.assistantSpend)
		out.push(`  ${s.plan.padEnd(6)} ${String(s.spenders).padStart(5)} accounts  p50 ${usd(s.p50UsdMicros)}  p90 ${usd(s.p90UsdMicros)}  total ${usd(s.totalUsdMicros)}${s.unpricedTurns ? `  (${s.unpricedTurns} unpriced turns: a floor)` : ''}`);
	const n = r.newAccountFreeSpend;
	out.push('', `Free assistant spend by accounts under 7 days old: ${usd(n.newUsdMicros)} of ${usd(n.totalUsdMicros)} = ${pct(n.share)} (an upper bound; > 50% → escalation b)`, '');
	out.push('Heaviest Free accounts (assistant spend)');
	if (r.heaviestFree.length === 0) out.push('  none');
	for (const h of r.heaviestFree) out.push(`  ${h.accountId}  ${usd(h.usdMicros)}`);
	out.push('', 'Abuse signals');
	const days = r.abuse.signupsPerDay;
	const top = [...days].sort((x, y) => y.signups - x.signups).slice(0, 3);
	out.push(`  sign-ups this month: ${days.reduce((s, d) => s + d.signups, 0)} on ${days.length} days; busiest: ${top.map((d) => `${d.day} (${d.signups})`).join(', ') || 'none'}`);
	out.push(`  email domains with ${CLUSTER_WEEK}+ sign-ups in 7 days: ${r.abuse.domainClusters.length === 0 ? 'none' : ''}`);
	for (const c of r.abuse.domainClusters)
		out.push(`    ${c.domain}  ${c.busiestWeek} in the 7 days from ${c.weekFrom} (${c.signups} this month)${c.commonProvider ? '  common provider' : ''}`);
	out.push(`  canonical addresses with more than one account: ${r.abuse.canonicalClusters.length === 0 ? 'none' : ''}`);
	for (const c of r.abuse.canonicalClusters) {
		out.push(`    ${c.userIds.length} accounts (${c.inMonth} this month)${showEmails ? `  ${c.canonical}: ${c.emails.join(', ')}` : ''}`);
		out.push(`      users ${c.userIds.join(', ')}`);
	}
	const g = r.gateRefusals;
	out.push(`  disposable-domain refusals by the verified-email gate: ${g.disposable.total} (assistant ${g.disposable.assistant}, feeds ${g.disposable.feeds})`);
	out.push(`  unverified-email refusals by the same gate: ${g.unverified.total} (assistant ${g.unverified.assistant}, feeds ${g.unverified.feeds})`);
	out.push('  (both counted only while BILLING_ENFORCED is on, and only since migration 348)');
	out.push('', 'Not yet measurable');
	for (const m of r.notYetMeasurable) out.push(`  ${m.metric}: ${m.needs}`);
	return out.join('\n');
}
