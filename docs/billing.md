# Billing

Paid plans for IC-WBT ([issue #641](https://github.com/jaredhoward-dev/project-water-management/issues/641)).
This page covers **Phase 1, shadow mode** (every plan, limit and count exists
and is shown) and **Phase 2's enforcement, built but off**: the seat and
live-catchment limits (`402 plan_limit`), the assistant's dollar caps, the
pause after a downgrade, the reverse trial and Free's verified-email gate all
refuse only while `BILLING_ENFORCED` is on, which it isn't in production
([§ Live catchments (Free)](#live-catchments-free), [§ Pausing after a
downgrade](#pausing-after-a-downgrade), [§ Verified email on
Free](#verified-email-on-free)). Phase 3's provider
seam, webhook, checkout and portal are built and run locally behind the mock
provider; production runs `manual` until the Stripe account exists
(Terraform's `billing_provider` switch; the operator's steps are
[deployment.md § Turning on Stripe](./deployment.md#turning-on-stripe)). It
also covers [staff grants](#staff-grants), the operator's plans by hand
(invoiced business customers, founding users, Team's trial). The issue holds
the full design (tiers, enforcement, provider, legal and tax prerequisites);
the later phases are listed at the end as pointers to it.

## Who the plan belongs to

A plan belongs to a **billing account**, which is either a **person** or a
**team** (`billing_account.kind`: `user` or `team`; exactly one of `user_id`
and `team_id` is set, each unique).

- Each project bills to one account through `project.billing_account_id`:
  a team project to its team's account, any other project to its creator's
  own account. New projects get it from a trigger; existing ones were
  backfilled (`323_billing`).
- An account's live `subscription` gives its plan. **No live subscription
  means Free.** In Phase 1 no one has a subscription, so every account is on
  Free.
- **Who reads a plan, and where *Compare plans* goes.** A person reads
  their own account's plan; a team's is read by its admins only
  (`app_billing_account_readable`, 323: `GET /teams/:id/plan` is `404` to a
  team member, a team viewer and someone shared a team project directly
  outside the team). So every *Compare plans* link is built by
  `planLink` (`frontend/src/lib/components/billing/planLink.ts`) from the
  project's `team`, whose `role` is the caller's role in it
  (`app_team_role`; `null` outside the team; [api.md](./api.md)): a
  personal catchment opens `/account/plan`, a team admin `/teams/:id/plan`,
  and anyone else in a team catchment the public price list
  (`/welcome/pricing`) with "This catchment is on *team*'s plan: ask a team
  admin to change it." (*its team's plan* for someone outside the team, who
  can't read its name). Not their own plan: the catchment bills to the
  team, so upgrading their own account wouldn't change what it may do, and
  the price list shows what the team's admin would be choosing between. A
  team without `role` (the list's summary, an older API) counts as not an
  admin: the price list is always there, a plan page they can't open is a
  404.
- Pro attaches to a person, Team to a team. In Step 4 a billing account
  becomes an organisation 1:1 ([roadmap step 4](./roadmap/step-4-platform.md)), so nothing here
  is thrown away.
- Accounts are created on first need: when a project needs one, or when
  someone asks for their own plan (`GET /account/plan`) or a team admin asks
  for the team's. So `GET /account/plan` is a read that writes: the first
  time a person (a farmer, say, who never made a project) opens the page, it
  inserts their empty `billing_account` row. That is harmless: the row holds
  no more than who it belongs to, a zero project count and when it was made;
  it is on Free like no row at all; it goes with the person
  (`ON DELETE CASCADE`) and is in their data export; at most one exists per
  person or team (unique, and the insert is `ON CONFLICT DO NOTHING`, so two
  first reads at once make one row); and only the signed-in person can make
  their own (the definer function takes no account id).

## Tables

All in `backend/migrations/323_billing.sql`; columns and RLS in
[data-model.md](./data-model.md).

| Table | Holds |
| --- | --- |
| `plan` | The plans (`free`, `pro`, `team`): name, monthly and annual price in ZAR cents, `limits` (a closed, CHECK-validated key set; a JSON `null` is unlimited), `features`, trial days, `active`. Written only by migrations |
| `billing_account` | One per person or team that has needed one, and its lifetime count of projects created |
| `subscription` | An account's plan, status, seats and period; at most one live per account. Written by the webhook (326) and the staff grant (330) |
| `billing_grant_log` | The staff grant's audit log (330): every grant, revocation and expiry ([§ Staff grants](#staff-grants)) |
| `usage_counter` | Monthly counts per account and kind (`reports`, `packs_issued`); `month` is the first day of the month in Africa/Johannesburg |

The assistant's monthly total is **not** a counter: it is summed from
`assistant_usage` through `project.billing_account_id`, so it is never kept
twice.

Everything is read and written through `SECURITY DEFINER` functions with a
pinned `search_path`, as the signed-in person (`withUser`, CLAUDE.md rule 1):

| Function | What it answers |
| --- | --- |
| `app_billing_plans()` | The active plans; anyone |
| `app_my_billing_account()` | The caller's own account, created if missing |
| `app_team_billing_account(team)` | The team's account, created if missing; `NULL` unless the caller is a team admin |
| `app_account_plan(account)` | The account's plan, subscription and this month's usage; `NULL` unless the caller is the account's person or an admin of its team |
| `app_entitlements(project)` | The project's plan, limits, features and status; `NULL` below editor (farmers and viewers never see plan data) |
| `app_usage_add(project, kind, qty)` | Adds to the project's account's counter for this month; needs a role on the project; never refuses |

## Shadow mode

What Phase 1 counts, each in the same transaction as the action it counts,
so a count commits or rolls back with it (`backend/src/billing/entitlements.ts`
`countUsage`):

- **Server PDF reports**: one per report queued, on demand or by a schedule
  (`reports/store.ts` `createReport`). A schedule fire that was already queued
  (its dedupe key) counts nothing.
- **Issued evidence packs**: one per issue (`evidence/packs.ts`, the issue
  route). Drafts, sign-offs, withdrawals and verify never count.
- **Catchments**: not a counter; `app_account_plan` counts the account's
  active projects (not archived, not deleted).
- **Assistant tokens and cost**: summed from `assistant_usage` (above), in
  its UTC month. `usage.assistantTokens` is the weighted tokens;
  `usage.assistantCost` is the dollar cost the backend records per turn
  (`324_assistant_turn_cost`) against the plan's dollar allowance:
  `assistant_usd_micros_per_month` (Free $1, Pro $15), or on Team
  `assistant_usd_micros_per_seat_month` × its seats ($15 each; the live
  subscription's seats, never fewer than the 3 included). Its
  `unpricedTurns` counts turns with no price (a model missing from the price
  table, a charge from an older backend, an expired reservation), so a
  non-zero count means the cost shown is a floor.

Nothing is refused: a Free account past its five reports a month still gets
its sixth. The usage and the limit are shown, so the owner can see where they
would stand.

### `BILLING_ENFORCED`

The backend setting `BILLING_ENFORCED` (default `false`; only the exact string
`true` turns it on) says whether plan limits refuse anything. **Phase 1 only
reports it**: `GET /account/plan` and `GET /teams/:id/plan` return it as
`enforced`, so the UI can word the usage bars ("what you would hit"). The
limits built to refuse on it are a Team's editor seats
([§ Team seats](#team-seats)) and the assistant's dollar caps
([§ Assistant dollar caps](#assistant-dollar-caps)), Free's one live catchment
([§ Live catchments (Free)](#live-catchments-free)) and Free's verified-email
gate ([§ Verified email on Free](#verified-email-on-free)); everything else still only counts. Set it in
`backend/.env.development.local` to see the enforced wording locally
([run-locally.md](./run-locally.md#one-time-setup)).

## Assistant dollar caps

Built, **off unless `BILLING_ENFORCED`** (issue #641 "Free AI allowance" and
"Free tier and abuse", accepted 2026-10-29; `336_assistant_dollar_caps.sql`, `337_assistant_sast_day.sql`,
`backend/src/assistant/dollarCaps.ts`). `app_assistant_begin` checks them
after the token caps (264), against the project's billing account, and
reserves the turn's dollars beside its tokens, so the month's (and day's)
spend plus every running turn's reservation never passes a cap, however many
turns run at once (begins are serialised by 264's deployment lock).

| Cap | Who | Limit | Refusal (`429`, `Retry-After`) |
| --- | --- | --- | --- |
| Day | A person on a Free account | `ASSISTANT_FREE_USD_PER_DAY` ($0.30) **or** `ASSISTANT_FREE_MESSAGES_PER_DAY` (20) a SAST day (00:00 to 24:00 South African time), whichever first | `assistant_daily_cap`, until 00:00 SAST (22:00 UTC) |
| Month | The account | The plan's `assistant_usd_micros_per_month` (Free $1, Pro $15), or `assistant_usd_micros_per_seat_month` × seats (Team, $15 each, the live subscription's seats, never fewer than 3) | `assistant_monthly_cap`, until the UTC month ends |
| Member | A person on a per-seat (Team) account | `billing_account.assistant_member_max_pct` of the account's month (50% unless a team admin changes it, below) | `assistant_member_cap`, until the month ends |
| Trial, trial day | A person on a reverse trial (342) | $2 over the trial, $1 a SAST day ([§ The reverse trial](#the-reverse-trial-built-off)) | `assistant_trial_cap` (until the trial ends), `assistant_trial_daily_cap` (until 00:00 SAST) |
| Pool | Free and trialing accounts together | `ASSISTANT_FREE_POOL_USD_PER_MONTH` ($30) a UTC month, and on any SAST day at most (pool left at the day's start ÷ SAST days left in the UTC month, today included, at least 1) × 2 | `assistant_free_pool_spent`, until 00:00 SAST (or the UTC month's end, when the month's pool is spent) |

Checked in that order, the person's own caps first, so a refusal names the
cap that is theirs when it binds; the pool's wording says it isn't something
they did and has no upgrade prompt (#641's copy). Each refusal is a stable
code with `params.seconds` and `params.resetsAt` ([api.md §
Assistant](./api.md#assistant)).

**Reserving dollars.** A turn's dollars are its token budget × the model's
dearest price per weighted token (`pricing.ts` `usdMicrosPerWeightedToken`:
the greatest of input, cache write and output ÷ 5; Sonnet 5.5 2.5
micro-USD), rounded up, so no turn within its budget can cost more. Enforced,
the token budget is cut to what the tightest dollar cap has left at that
price (a fresh Free person's turn: $0.30 ÷ 2.5 = 120 000 tokens), and a cap
with less than the turn's floor left refuses. A model with no price reserves
no dollars, and only a cap already spent refuses it. The charge moves the
real cost onto the person's day row (`assistant_day_usage`) and the month's
(`assistant_usage.cost_usd_micros`); a reservation that expires unsettled is
charged its dollars in full.

**Off** (the default), nothing new refuses and the budget is exactly 264's;
the dollars are still reserved and recorded and the day's messages counted
(shadow mode), so the report can measure what enforcement would do.

**The day is South Africa's; the month is UTC.** The Free day, and the day
the pool's share is paced on, run 00:00 to 24:00 SAST (Africa/Johannesburg,
UTC+2 with no daylight saving), as #641 states (337; 336 had used the UTC
day). Every month stays UTC: `assistant_usage` is keyed by the UTC month
(262), and the token caps, the dollar month, a Team member's share, the
pool's month and the Plan page's usage all read it. Moving the month too
would re-key that table and every caller to shift the turnover by two hours,
so the simplest consistent answer is one UTC month for everything and a SAST
day only where a person meets a day. Where the two meet:

- The pool's "days left" counts SAST days left in the UTC month. From 22:00
  to 24:00 UTC on a month's last day the SAST day is already the next
  month's first, so none is left and the count is 1: the share is what the
  month's pool has left, × 2 (the month's own cap still binds).
- From 00:00 UTC (02:00 SAST) on the 1st the month is new, but the SAST
  day's spend still holds the two hours before it. The begin floors the
  month's spend before today at 0, so those hours count against the new
  month's first day's share: a little less, never more.
- A refusal's `params.resetsAt` (and `Retry-After`) is the next 00:00 SAST
  for the day and a pool day, the first instant of the next UTC month for
  the month, a member's share and a spent pool month.

Rows written before 337 hold a UTC day; they are kept and read as the SAST
day of the same date. On deploy day D, before 22:00 UTC, D's row (spend
since 02:00 SAST) is read as SAST day D's, so that one day misses at most
the two hours from 00:00 to 02:00 SAST; between 22:00 and 24:00 UTC the SAST
day is already D+1 and starts empty. Nothing is rewritten, and the purge is
unchanged (it drops day rows before the kept months' first date).

**The pool's alarms.** Each begun turn of a pool account logs
`assistant_free_pool` (amounts only) once the pool's month has passed 50% or
80%; two CloudWatch metric filters and alarms in `infra/alarms.tf`
(`assistant-free-pool-50`, `-80`) page through the alerts topic. They run in
shadow mode too. A log-metric alarm was chosen over a scheduled job because
the assistant's other spend alarms already work that way and it needs no
new job or table.

**The member share.** A team's admins set it, from 1% to 100% (100: no
per-member limit), with *Assistant share* in the team's Plan card ([ui.md §
Plan and usage](./ui.md#plan-and-usage)), which posts `POST
/teams/:id/plan/assistant-share` ([api.md § Billing](./api.md#billing)).
The only writer is `app_team_set_assistant_share` (339, SECURITY DEFINER,
as every `billing_account` write): NULL to anyone but the team's admins (the
route's 404), and 23514 outside 1–100. `GET /teams/:id/plan` shows it as
`team.assistantMemberMaxPct`. The share binds from each member's next turn,
and only on a per-seat plan; on Free or Pro it is kept for when the team
moves to Team. Like the other caps, nothing refuses past it unless billing is
enforced.

**The questions-left meter** (`350_assistant_day_meter.sql`,
`351_assistant_day_meter_own_median.sql`, `usage.ts` `dayMeter`). With billing enforced, the assistant's status (`GET
/projects/:id/assistant`, [api.md § Assistant](./api.md#assistant)) carries
`day` for a person on a capped account, Free or a reverse trial: the SAST
day's dollars and what's left of them (the day row's cost plus every
reservation begun today, as the begin counts them), Free's messages left, the
trial's whole $2 left, and the person's own median question: the median,
over their own day rows on the account in the last 30 SAST days that
recorded a priced turn, of the row's cost ÷ its messages, rounded up (351;
350 took every member's rows, which let any viewer of a Free or trial
project read the account's typical spend, so the operator moved it to the
person's own, 2026-11-24). With no priced day of their own it is null, and
the panel falls back: Free says its messages left, a trial the share of its
day left. The trial's $2 left is the one account-wide figure in `day`, by
nature: the trial's $2 is the account's (the begin counts every member's
rows and reservations against it, 342), so a member sees what the account
has left of it, which is what refuses their next turn. The panel turns that into "About 6
questions left today, at what your questions usually cost (an estimate)"
([ui.md § Assistant](./ui.md#assistant)). Per-turn costs aren't kept (the
month and day rows hold sums), so the median is of daily averages, and a
turn still running when the status is read makes its day look cheaper (its
message is counted at begin, its cost at the charge): an estimate, and worded
as one. The Free pool isn't in it (not the person's allowance; its refusal
says so). Off, a paid plan, or no billing account: `day` is null. It reads
the person's own sums, not `assistant_dollars_spent` (which scans every pool
account's month), since the status is read each time the panel loads and
again after each turn.

**Not built yet** ([followups.md](./followups.md#billing-issue-641)): Haiku
on Free.

## Metrics and the abuse report

The [issue's](https://github.com/jaredhoward-dev/project-water-management/issues/641)
"Phase 1 metrics and thresholds" and the staff report of "Free tier and
abuse". The app has no staff role, so this is an **operator script run as
the schema owner**, like `pnpm dev:authority:confirm`:

```bash
pnpm dev:billing:report                     # this SAST month, as text
pnpm dev:billing:report --month 2026-10 --json
pnpm dev:billing:report --show-emails       # operator only: prints the addresses of canonical clusters
```

It reads two owner-only functions (`325_billing_metrics.sql`; never granted
to `water_app`, [data-model.md](./data-model.md)), 338's owner-only
`app_live_catchments_in_use`, `billing_grant_log` and `subscription` (the
reverse trials) and the owner-only `email_gate_refusal` table (348) on this checkout's
database (`MIGRATION_DATABASE_URL`); in production the operator runs the
same code through the migrate Lambda's `billing-report` owner action
(`.github/workflows/billing-admin.yml`, approved in the `production`
environment; [deployment.md § Owner actions](./deployment.md#owner-actions)
and runbook 22), which answers with the report redacted as the script prints
it: never `--show-emails`. The maths is `backend/src/billing/metrics.ts`
(unit tests beside it), the script `backend/scripts/billing-report.ts`.

**What it prints.** Counts and aggregates; account or person ids only where a
signal needs a follow-up (the heaviest Free accounts, canonical clusters);
email domains only for a domain cluster. **No address** unless
`--show-emails` is given. That flag is for the operator's own terminal: its
output never goes into an issue, a PR, a chat or an agent's transcript.

| Metric | How it is worked out | Threshold (the issue's) |
| --- | --- | --- |
| Activation | Verified sign-ups of the month (SAST) with a model run within 7 days of signing up. Sign-ups under 7 days old are left out and counted as pending | < 30% → fix onboarding first |
| Active Free accounts near / at each limit | Active = a run, a server report or assistant use this month on the account's projects. Near ≥ 80% of the limit, at ≥ 100%, for reports (5), the assistant's dollars ($1), catchments (Free has no limit, so none) and live catchments (1: the share at the live-catchment limit). Catchments and live catchments are counted **today**; live is 338's count (`app_live_catchments_in_use`: an enabled feed or alert rule, automatic runs on, or a publication; [§ Live catchments](#live-catchments-free)), so an account past its limit from before enforcement counts as at it, and an idle account with a live catchment isn't in the share | > 15% at reports → 10 a month; < 3% at the monthly assistant cap → room to raise |
| Reverse trial → paid within 30 days | The reverse trials (342) that **began in the report's SAST month**: `billing_grant_log` `grant` rows by `reverse trial`, one per account (one trial per canonical email). Paid = the account's first paid plan at or after the trial's start: a subscription from a payment provider (`stripe`, or `mock` locally) whose first payment was taken: `active`, `past_due` or `canceled` (so a plan bought and later cancelled counts; not `trialing`, and not `expired`, Stripe's `incomplete_expired`, a first payment never made), or a paid B2B invoice's grant (`billing_grant_log` `grant` by `invoice`, 335); a staff grant is not paid. Converted when it came at most 30 days after the start. A trial under 30 days old is left out and counted as pending (with how many of those already pay). A deleted account's trial goes with it (`billing_grant_log` cascades) | |
| Assistant spend per account | p50 and p90 (nearest rank) per plan over the accounts that spent this month, with the total and any unpriced turns (then a floor) | Paid: > 20% at $15 → top-up packs sooner |
| Free spend by accounts under 7 days old | Its share of the month's Free assistant spend. `assistant_usage` is monthly, so an account counts as new when its latest spend of the month came under 7 days after it started: **an upper bound** | > 50% → escalation (b) |
| Heaviest Free accounts | The five with the most assistant spend, by account id | |
| Sign-ups per day | Per SAST day of the month; the three busiest printed | |
| Domain clusters | Email domains with 5 or more sign-ups in some 7 days of the month; common providers are marked, not hidden | Escalation (a) |
| Canonical clusters | Canonical addresses (lower-cased, `+tag` dropped, Gmail's dots dropped, googlemail.com as gmail.com) with more than one account, ever, where one signed up this month; the user ids | Escalation (a) |
| Disposable-domain refusals | Refusals by the [verified-email gate](#verified-email-on-free) of a disposable-domain address (`email_disposable`) this SAST month, by feature (assistant, feeds), and beside them its unverified refusals (`email_unverified`). Counted per SAST day in the owner-only `email_gate_refusal` (348; counts only: no address, domain, person or project), one autocommit `app_email_gate_refused` call per refusal made after the route's transaction has rolled back (`countGateRefusals`), so it never needs a second pooled connection (the assistant Lambda's pool is one); each refusal is also logged as `email_gate_refused` with its code and feature. Zero while `BILLING_ENFORCED` is off (the gate is), and no data before 348 | |

The plan is each account's plan **today**; in Phase 1 that is Free for
everyone. Runs, reports and sign-ups use the SAST month; the assistant's
spend keeps `assistant_usage`'s UTC month, as `app_account_plan` does.

**Not yet measurable**, printed as such so a gap is never read as a zero
(the app doesn't record what each needs): upgrade at the limit (no checkout,
trial or limit-message events), churn after the limit (no record of hitting
one), the share at the assistant's daily
cap and the Free pool's burn by day (`assistant_day_usage` keeps each day
since 336, but the report doesn't read it yet), paid seats reaching $15 (spend isn't kept per paid seat), sign-up throttle hits per address
(`signup_throttle` keeps only an hour's hashed buckets) and suspensions (no
suspend action yet).

## API

[api.md § Billing](./api.md#billing): `GET /billing/plans` (public),
`GET /account/plan` (signed in), `GET /teams/:id/plan` (team admins; `404`
to anyone else), and checkout and the portal for each
([§ Checkout and portal](#checkout-and-portal)). No farmer route, share link, verify page or email shows plan
data.

## Webhooks and providers

Phase 3 (issue #641 "Billing provider"): the provider seam and the webhook
route. No Stripe account is opened and no `stripe` package is installed;
checkout and the portal are [§ Checkout and portal](#checkout-and-portal).

### Providers

`BILLING_PROVIDER` picks one, in `backend/src/billing/provider.ts`:

| Provider | Webhooks | Use |
| --- | --- | --- |
| `mock` (code default) | Stripe-shaped events signed with the committed dev-only `BILLING_WEBHOOK_SECRET` in `backend/.env.development` | local dev and tests: the whole path with no Stripe account |
| `manual` | none (`404`) | subscriptions the operator records by hand; production's setting until Stripe is set up |
| `stripe` | Stripe's signed events, checked with `BILLING_WEBHOOK_SECRET` (the endpoint's `whsec_…`) | production, once the operator has the account |

Any other value names no provider, and every webhook is `404`. It never falls
back to the mock: feohledger's billing doc records how a mistyped provider
name that resolved to its signature-free mock opened its public webhook. The
production check (`config/production.ts`) refuses an unset `BILLING_PROVIDER`
(the mock) and anything but `manual` or `stripe` on the API Lambda, and with
`stripe` it requires a real `BILLING_WEBHOOK_SECRET` (32+ characters, not a
`dev-only-` placeholder). Terraform sets `BILLING_PROVIDER = "manual"` on the
API (`infra/lambda.tf`).

### Signature check

`provider/signature.ts` checks Stripe's `Stripe-Signature: t=<unix>,v1=<hex>`
with `node:crypto`. It was ported from threkir's `_shared/webhook_security.ts`
(`verifyTimestampedHmac`):

- The HMAC-SHA256 is over `"<t>.<raw body>"`: the bytes as received, never a
  re-serialised JSON.
- `t` must be plain digits, and the signed text is the header's own, so
  `t=+…`, `t=…junk` and a zero-padded `t` fail.
- Every `v1` is compared, each in constant time (`timingSafeEqual`); Stripe
  sends two during a secret rotation. `v0` is ignored.
- The tolerance is 300 s in both directions. A replay of a captured event
  fails even though its HMAC is good, and a far-future `t` can't buy a long
  replay window (the half feohledger's doc records once being missed).

The mock signs the same way with the dev key, so the same check serves both.

### Normalised events

`provider/stripe.ts` turns the six types #641 names into what
`app_billing_apply` (326) takes. The account is the metadata
`billing_account_id` (a UUID) and the plan its `plan_code`, both set at
checkout. Every payload carries the event's `created` time as `eventCreated`
(ISO), which orders the events (§ Event order below).

| Stripe type | Normalised type | Effect in 326 |
| --- | --- | --- |
| `customer.subscription.created`, `.updated` | `subscription.updated` | the account's subscription upserted by (provider, `externalRef`) |
| `customer.subscription.deleted` | `subscription.deleted` | status `canceled` |
| `checkout.session.completed` | `checkout.completed` | recorded only |
| `invoice.paid` | `invoice.paid` | recorded only; a staff-tool B2B invoice's (no subscription, our `wm_invoice_key`) grants its plan (335, [§ B2B invoices](#b2b-invoices)) |
| `invoice.payment_failed` | `invoice.payment_failed` | recorded only (Stripe moves the subscription to `past_due` and sends `customer.subscription.updated`) |

The subscription payload is `{ accountId, planCode, status, seats,
periodStart, periodEnd, trialEnd, cancelAtPeriodEnd, externalRef, interval?,
eventCreated? }`, with times as ISO 8601 in UTC (`…Z`); `eventCreated` is
absent (or `null`) from the mock and `manual` providers (§ Event order). `seats` is the
metadata's `seats_included` (1 when absent) plus every item's quantity past
the base item's 1: checkout makes the plan one item at quantity 1 and Team's
extra seats a second item ([§ Team seats at checkout](#team-seats-at-checkout)),
so the sum needs no telling which item is which, in whatever order Stripe
lists them, and a one-item subscription without `seats_included` reads as its
item's quantity, as before (`seatsOf`). The period is read from the first
subscription item (API `2025-03-31.basil` moved it there), else from the
subscription itself (older versions). `interval` is the items' price
`recurring.interval` (`intervalOf`; [§ Billing interval and editor
count](#billing-interval-and-editor-count)). An invoice's subscription is read from
`parent.subscription_details` (basil), else `subscription_details`.

Stripe's statuses map as follows:

- `trialing`, `active`, `past_due` and `canceled` keep their names.
- `unpaid` becomes `past_due`: still owed, not ended.
- `incomplete_expired` becomes `expired`.
- `incomplete` and `paused` grant nothing new, so they become
  `subscription.pending`, recorded only.

Any other Stripe type is answered `200 ignored` and never written: Stripe only
sends the types the endpoint enables, so one here is a dashboard slip.

### The route

`POST /billing/webhook/:provider` ([api.md § Billing](./api.md#billing)) is
public: the signature is the credential.

1. `:provider` must name the configured provider, and one that takes webhooks.
   Otherwise the answer is `404`, before the body is read.
2. The body is capped at 256 KiB and read once as text.
3. Then the signature check and the normalisation. Either failing answers
   `400` with a fixed message (`invalid signature`, `invalid event`).
4. `app_billing_apply(provider, event id, type, payload)` runs in a
   transaction with no user (`withoutUser`, like the job tick's definer
   calls), never as `water` and never with BYPASSRLS. It records the event
   once (a redelivery is `duplicate`) and is the only writer of subscription
   status.

How each result of `app_billing_apply` is answered:

| Result | Answer | Log level |
| --- | --- | --- |
| `applied`, `recorded`, `duplicate`, `stale` | `200 { received: true, result }` | info |
| `conflict`, `unknown_account` | `200` (a retry wouldn't change them) | warn, for the operator to read |
| `invalid` | `400` (326 doesn't record it, so a corrected retry under the same id still applies) | warn |
| an orphan, cancelled and refunded | `200 { received: true, result: 'orphan_refunded' }` | warn, with `cancelled`, `refunds`, `refundedMinor` |
| an orphan whose cancel or refund failed | `503 { error }` (the event stays `orphan_pending`; Stripe redelivers it) | error, `result: 'orphan_failed'` |

A database error is the app's generic `500`, which Stripe retries. Each answer
logs one line (`billing_webhook` or `billing_webhook_rejected`) with the
provider, type, event id and result or reason. It never logs the payload, the
account or the secret.

**An orphan** (352) is a subscription made for an account that no longer
exists: a checkout paid after the account was deleted ([§ Deleting an
account](#deleting-an-account)). It is a live `subscription.updated`
(`trialing`, `active`, `past_due`) that `app_billing_apply` answers
`unknown_account`, or a `checkout.completed` it records with no account. In
the same transaction, `app_billing_orphan_claim` marks the event row
`orphan_pending`. The provider's `cancelOrphan` then cancels the
subscription now and refunds what was paid for it, and
`app_billing_orphan_done` marks the row `orphan_refunded`. A redelivery is a
`duplicate` to `app_billing_apply`, but the claim still finds a pending row
and tries again; a finished one is a plain `duplicate`. Only a row that was
unknown when its own first delivery applied can become pending, so a
redelivered event whose account was deleted afterwards (and whose plan the
delete already cancelled) is never refunded. An unknown account's
`subscription.deleted`, an ended status, an `invoice.*` event and a
`subscription.pending` stay `unknown_account` or `recorded`, as before.

### Event order

Stripe doesn't deliver events in the order it created them, so 327 orders
them by `eventCreated`. Each subscription keeps the time of the newest event
applied to it (`subscription.last_event_at`):

- An update older than that time is answered `stale` and changes nothing.
  It is recorded on `billing_event` with that outcome, so its redelivery is a
  `duplicate`.
- An update at the same time applies, so the later arrival wins. Stripe's
  `created` is in whole seconds, and two real changes in one second must not
  lose the second.
- An update with no `eventCreated` (or `null`), as the mock and `manual`
  providers send, applies in arrival order as before 327 and leaves the time
  unchanged. A malformed one (not ISO 8601 with an offset) is `invalid`.
- A delete is never stale: it is the provider's last word, and a late live
  update after it is already a `conflict`.

### Retention

The job tick deletes `billing_event` rows received more than 90 days ago
(`app_purge_billing_events`, `jobs/runner.ts`
`BILLING_EVENT_RETENTION_DAYS`). That is far past Stripe's redelivery
window of up to 3 days, so a redelivery always finds its row and is a
`duplicate`. The function refuses anything under 4 days.

### Locally

`pnpm dev:billing:replay <fixture> [--account <id>] [--new-id]` signs one of
the synthetic events in `backend/fixtures/billing/` with the dev key and posts
it to the running API's `/billing/webhook/mock` ([run-locally.md § Billing
webhooks](./run-locally.md#billing-webhooks)). Every id in the fixtures is
invented, and their account is a placeholder UUID that `--account` replaces.
The fixtures are `checkout-completed`, `subscription-created` (trialing),
`subscription-updated` (active), `subscription-past-due`,
`subscription-deleted`, `subscription-team-seats` (Team, 5 seats as two items),
`subscription-team-yearly` (the same, billed yearly),
`invoice-paid` and `invoice-payment-failed`.

### Tests

- `billing/provider/signature.test.ts`: good, tampered, stale and future
  signatures, the wrong secret, several `v1` values, malformed headers.
- `billing/provider/stripe.test.ts`: each type, the status map, both API eras,
  and the refusals.
- `billing/provider.test.ts`: the provider choice.
- `billing/webhook.test.ts`: the route with the database mocked.
- `config/production.security.test.ts`: production refuses the mock.
- `billing/webhook.db.test.ts`: the route against 326. A signed event applies,
  a replay or a forgery changes nothing, and an unknown account is a `200`.
- `billing/orphan.db.test.ts`: an orphan against 352, with the mock's
  `cancelOrphan` watched: cancelled and refunded once across redeliveries, a
  failure answers `503` and the redelivery finishes it, a completed checkout
  counts, an ended subscription doesn't, a known account applies as before,
  and an event redelivered after its account went is a plain `duplicate`.
- `billing/apply.db.test.ts`: `app_billing_apply` itself (326, 327) as
  `water_app` with no user: once only, the status moves, conflicts, unknown
  accounts and invalid payloads, stale updates by `eventCreated`, and the
  tick's purge of `billing_event`.
- `mail/templates.renewal.test.ts`: the renewal email's words in English
  and Afrikaans (plan, the period end in South African time under the
  skewed `TZ`, the rand amount, the plan page link), and wholly English when
  the Afrikaans catalogue is incomplete.
- `config/devDbReset.test.ts` and `scripts/guards/docker_volumes.test.mjs`
  aren't billing's, but came in the same round: the guard on
  `pnpm dev:db:reset`, and that only `dev:docker:wipe` deletes the shared
  docker volumes ([testing.md § Several checkouts at
  once](./testing.md#several-checkouts-at-once)).

[§ Renewal notice](#renewal-notice) lists its own tests
(`businessDays.test.ts`, `renewal.db.test.ts`), and [§ Checkout and portal
› Tests](#checkout-and-portal) lists checkout's (`checkout.test.ts`,
`checkout.db.test.ts`, `provider/stripeApi.test.ts`,
`provider/mock.test.ts`).

## Renewal notice

The Consumer Protection Act s14(2)(c) has a supplier tell an individual on a
fixed-term agreement, **not more than 80 nor less than 40 business days**
before it ends, that it is ending, of any material change on renewal, and
of their options. #641 sends it **60 business days** before. The code is
`backend/src/billing/renewal.ts` and `businessDays.ts`; the sent-log is
`329_renewal_notice.sql`.

**Who gets one.** A subscription that is `active` or `past_due`, not
`cancel_at_period_end`, on a **person's** account (`billing_account.kind =
'user'`; s14(1) leaves out agreements between juristic persons, and a team's
account is its organisation's), whose period is **a year**. `subscription`
records no billing interval, so a year is read from the period:
`period_end − period_start` of 300 days or more. A Stripe subscription's
current period is its interval, so this needs nothing new from the webhook;
a monthly period (≤ 31 days) is never picked, and a trial isn't either (it is
`trialing`). The email goes to the account's person, in their language.

**When.** Each worker tick (after the jobs, [architecture.md § Background
work](./architecture.md)) takes today's date in South Africa and queues every
such subscription whose period ends on a date with **45 to 60** business days
strictly between today and it (neither day counts). So the notice is queued
on the first tick 60 business days out; a missed day (an outage, a
subscription recorded late) still sends, down to 45. The floor is 45, not
the Act's 40, to leave room for up to five public holidays declared after
the code was written (an election day), which the count can't know.

**Business days.** Weekdays less South Africa's public holidays
(`businessDays.ts`): the Public Holidays Act's ten fixed dates, Good Friday
and Family Day (from Easter, computed), and the Monday after a holiday that
falls on a Sunday. Without them a weekday-only count runs up to six days
long over December and Easter, which at the 40-day edge would make a notice
late; no dependency is needed for them.

**Once per period.** `renewal_notice`'s primary key is (subscription,
`period_end`): two ticks at once insert one row, and claiming moves it to
`sending` under `FOR UPDATE SKIP LOCKED`, so two senders never both send it.
A renewed period has a new `period_end` and gets its own notice next year.
Like the pack notices (133): a send error retries on the next tick (3
attempts), and a worker that dies mid-send leaves the notice `failed`, never
sent twice. The rows are kept (no purge) as the record that the notice went,
go with the subscription, and are in the person's data export (`billing`).

**Built as the recipient.** Each notice is built in a read-only transaction
as its person, under RLS: the subscription is read again as they see it, and
a notice whose plan was cancelled, ended or moved to another period since it
was queued is `skipped`, as is one to an unconfirmed or suppressed address.

**What it says** (`renewalNoticeMail`, keys `mail.renewal.*` in
`backend/src/mail/i18n/en.ts`): the plan's name, the date this year of it
ends and renews (South African date), the next year's price
(`plan.price_annual_minor`, as rand), how to cancel (the plan page,
`/account/plan`, which goes on to the billing portal; cancelling before the
date charges nothing more), and the Act's right to end a yearly plan at any
time on 20 business days' notice. The log lines (`renewal_notice_sent`,
`renewal_notice_skipped`, `renewal_notice_prepare_failed`) name the
subscription id only: never the address, the person or the price.

**Open points** (for the CPA opinion, [legal-status.md](./legal-status.md)):

- s14(2)(d) continues an expired fixed-term agreement **month to month**
  unless the consumer directs otherwise; #641 renews the year. Whether a
  yearly renewal needs the person's express choice is for counsel.
- The price in the email is the plan table's. If Stripe's price for the
  subscription ever differs (a price change on 30 days' notice), the email
  must take the provider's.
- The cancellation penalty for ending a yearly plan early (#641 recommends
  none or one month) is not decided; the email names none.
- The email links the plan page, not the portal itself: a Stripe portal
  session is short-lived and per sign-in, so it can't go in an email.

**Tests.** `billing/businessDays.test.ts` (holidays, Easter, the Sunday rule,
weekends, month and year edges, the date range against the count for every
day of 2026–2028); `billing/renewal.db.test.ts` (who is picked, the 45/60
edges, one send from two ticks at once, team accounts, monthly plans, trials
and cancelling plans left out with positive controls, a skip after a cancel,
RLS on the log). All run under the workspace's skewed `TZ` (CLAUDE.md rule
7).

## Checkout and portal

Phase 3, behind the same providers (`backend/src/billing/provider.ts`). The
plan page asks the API for a URL and sends the person there; the API never
sees a card (Stripe Checkout keeps PCI scope at SAQ A, as #641 says).

| Provider | `createCheckout(account, plan, interval, urls, seats)` | `createPortal(account)` |
| --- | --- | --- |
| `mock` | a URL to the mock's checkout page on this API | a URL to the mock's portal page on this API |
| `manual` | `409 billing_unavailable` | `409 billing_unavailable` |
| `stripe` | makes the account's Stripe customer the first time (stored by 328), then a hosted Checkout session; the URL is Stripe's | a Customer Portal session for the stored customer; `409 billing_no_customer` when there is none |

### Routes

`POST /account/plan/checkout` and `/account/plan/portal` (your own account),
`POST /teams/:id/plan/checkout` and `/teams/:id/plan/portal` (a team's, for
its admins) ([api.md § Billing](./api.md#billing)). Each:

1. Resolves the account and checks access as the caller, through 323's
   functions (`app_my_billing_account`, `app_team_billing_account`,
   `app_account_plan`): a team's is `404` to a member, a viewer, a farmer on
   its projects and a stranger, before any provider check, so the answer
   never depends on the provider.
2. Refuses `manual` or no provider (`409 billing_unavailable`).
3. Checkout only: the plan must be the account's kind (Pro for a person,
   Team for a team), and there must be no live subscription (`409`: Manage
   billing changes the one there is, so Stripe never holds two), except a
   reverse trial (`manual` + `trialing`, read through
   `app_billing_live_subscription_ref`; `checkoutBlockedBy`), which the paid
   plan replaces when its webhook lands ([§ The reverse trial](#the-reverse-trial-built-off),
   344). A staff or invoice grant, or a paid plan, still answers `409`. The body's
   optional `seats` must be a whole number from the plan's included seats to
   50, on a plan that sells extra seats (`400` otherwise;
   [§ Team seats at checkout](#team-seats-at-checkout)).
4. Calls the provider outside any transaction (a network call never holds a
   database transaction open). A provider failure, or `stripe` with no key,
   is `503 billing_provider_error`, never the provider's text (rule 6).
5. Stores a customer the provider made through
   `app_billing_set_customer_ref` (328). The first stored customer wins; if
   another checkout stored a different one first, this one answers `409` and
   the person tries again, so they never pay into a customer the account
   doesn't keep.
6. Answers `{ url }` with `Cache-Control: no-store`, and logs one line
   (provider, plan, interval, seats; never the URL, which carries a session).

The plan page's success and cancel URLs are `SITE_URL` plus the plan page
with `?checkout=done` or `?checkout=cancelled`, as the emails' links are.

### Team seats at checkout

Team's price includes 3 editor seats, plus R499 a month (R4,990 a year) for
each extra editor (#641 "Recommended tiers"; `plan.limits.seats_included` and
`plan.features.extra_seat_monthly_minor` / `extra_seat_annual_minor`, 323).
Checkout sells them:

- **The body.** `seats` is the editor seats in all, at least the included
  ones and at most **50** (`MAX_CHECKOUT_SEATS`; past that is the Agency
  tier, a contract). Absent, it is the included seats. A plan that prices no
  extra seats (Pro) takes only its one seat. The route reads both prices
  from `GET /billing/plans`' row (`checkoutPlanOf`), so `plan` stays the one
  source of prices.
- **Stripe.** The plan as one line item at quantity 1, and, past the
  included seats, a second line item of the extra seats at the extra-seat
  price (inline `price_data`, product `IC-WBT Team: extra editor seat`). The
  metadata gains `seats_included`, which the normaliser adds to the extra
  quantity ([§ Normalised events](#normalised-events)).
- **The mock.** Its token carries the seats, the included ones and each
  extra seat's price; its page shows them and the whole price; its
  subscription event has the same two items and metadata as Stripe's, so
  `subscription.seats` comes out of the same normaliser. Its portal's cancel
  event keeps them.
- **Where it lands.** `subscription.seats` (326/327 store the payload's
  `seats` as given), which 324's assistant allowance already multiplies
  ($15 × seats, never fewer than the included 3).
- **Changing seats later** is `POST /teams/:id/plan/seats`
  ([§ Changing a Team's seats](#changing-a-teams-seats)): the portal can
  change an existing item's quantity but can't add the second item to a
  subscription bought at the included seats, since our prices are inline.

### Changing a Team's seats

Phase 5 ("per-seat quantity sync to Stripe (prorated)"). `POST
/teams/:id/plan/seats` with `{ seats }`, the editor seats in all
([api.md § Billing](./api.md#billing)), from the team plan page's *Change
seats* control ([ui.md § Plan and usage](./ui.md#plan-and-usage)):

1. **Access.** The team's admins only, through 323's functions as for
   checkout: `404` to anyone else, before any provider call.
2. **The body**, strict: `{ seats }` a whole number from 1 to 50, else
   `400`, before any subscription check.
3. **A live Team subscription.** `409` without one (none, ended, or a plan
   other than Team). The subscription's provider and id come from
   `app_billing_live_subscription_ref` (333), which answers the same people.
   A **staff grant** (provider `manual`) is `409 billing_grant_seats`: a
   grant's seats are changed by a new grant (`grant:plan --replace`, § Staff
   grants), never here. The `manual` provider, or none, is `409
   billing_unavailable`; a subscription another provider holds (a mock one
   after the switch to Stripe) is `409`.
4. **The seats.** A whole number from the plan's included seats to 50
   (`MAX_CHECKOUT_SEATS`), different from the current count; `400`
   otherwise, and for any other field.
5. **The provider** changes the subscription, outside any transaction. The
   route writes **no seats**: the provider's `customer.subscription.updated`
   brings them back through the webhook and `app_billing_apply`, as
   checkout's do, so `subscription.seats` keeps one writer per provider.

**Stripe** (`provider/stripeApi.ts`, `Stripe-Version: 2026-10-28.endive`):

- `GET /v1/subscriptions/:id?expand[]=items.data.price.product` reads the
  items. The extra-seat item is the one whose product is named `IC-WBT
  <plan>: extra editor seat` (checkout's `product_data`) or is ours by id;
  the other is the plan. A subscription edited by hand in the dashboard is
  refused: two extra-seat items, an item that is neither, the plan item at a
  quantity other than 1 (the seat count assumes 1, `seatsOf`), or an
  extra-seat item whose price bills at another interval than the plan's.
  Nothing is changed and the answer is `503 billing_provider_error`.
- **Update**: `POST /v1/subscription_items/:id` with the new extra
  `quantity`.
- **Add** (no extra-seat item yet): a subscription item's `price_data`
  takes a product id, not `product_data`, so the product is made once under
  a fixed id (`POST /v1/products`, id `wm_team_extra_seat`; Stripe's
  `resource_already_exists` means it is there), then `POST
  /v1/subscription_items` with the subscription, the extra quantity and
  `price_data` (currency, that product, the extra-seat price for the
  subscription's interval, read from the plan item's `recurring.interval`).
- **Remove** (back to the included seats): `DELETE
  /v1/subscription_items/:id`.
- Each change sends `proration_behavior=create_prorations` and an
  `Idempotency-Key` of the subscription, the item and its quantity, the new
  quantity and the minute, so a double click is one change at Stripe while
  the same change asked again later is a new one.

**Proration: a decision for the operator to confirm.** The code uses
`create_prorations`, Stripe's default, written out so a change of default
never changes ours: adding a seat mid-period creates a proration item for
the rest of the period, charged on the **next** invoice (not at once);
removing one credits the unused part on the next invoice. The alternatives
are `always_invoice` (invoice the proration at once) and `none` (the new
quantity from the next period only, no charge or credit now). Stripe's own
sources: the API reference for [updating a subscription item](https://docs.stripe.com/api/subscription_items/update),
[creating one](https://docs.stripe.com/api/subscription_items/create) and
[deleting one](https://docs.stripe.com/api/subscription_items/delete)
(`proration_behavior`: `always_invoice`, `create_prorations`, `none`;
default `create_prorations`), and [Prorations](https://docs.stripe.com/billing/subscriptions/prorations)
(read 2026-11-23; their examples name a newer version than ours, and the
parameters read the same). Changing it is the one constant `SEAT_PRORATION`.

**The mock** posts the signed `customer.subscription.updated` with the
extra-seat item at the new quantity (none at the included seats), the period
and status as they were (`seatsChangedEvent`), to the real webhook route in
process, so the plan page shows the new seats on its next read.

### Billing interval and editor count

Migration 332, so the plan page can say what a subscription costs and Team's
seat field can start at what the team uses.

- **The interval.** `subscription.billing_interval` (`month` or `year`;
  named so because `INTERVAL` is a type keyword) is written by
  `app_billing_apply`, redefined from 327, from the payload's `interval`:
  absent keeps the stored value (an older sender), `null` clears it, `month`
  or `year` sets it, anything else is `invalid` and changes nothing. The
  normaliser reads it from the items' prices (`price.recurring.interval`):
  every item must say the same plain month or year (`interval_count` 1 or
  absent), else it sends `null` (a quarter as 3 months, a week, items that
  disagree); items with no price at all send none, so the stored value
  stays. The mock puts the checkout's interval on each item's price, and its
  portal's cancel event carries the subscription's. A staff grant (330) and
  any row from before 332 have none.
- **The total.** `app_account_plan`, redefined from 324, adds the
  subscription's `interval`. The plan page works out the total from it, the
  seats and the plan's prices, as checkout prices them (the base plus each
  seat past the included ones at the interval's extra-seat price): *R 3 497.00
  a month for 5 editor seats*. With no interval it shows no total
  (`plan.ts` `subscriptionTotalLine`; [ui.md § Plan and usage](./ui.md#plan-and-usage)).
- **The editor count.** On a team's account `app_account_plan` also returns
  `team.editorCount`: the distinct people with editor or owner role on the
  team's projects (#641 § Who the plan belongs to): team members and admins
  (a team viewer is a viewer), and direct editors and owners of the team's
  projects, each counted once. Viewers, contributors and farmers hold no
  seat. Only who may read the plan (a team admin) sees it. Team's seat field
  starts at the larger of it and the included seats, with *This team has N
  editors.* beside it. Nothing refuses a checkout below the count: shadow
  mode counts and never blocks.
- **Tests.** `billing/interval.db.test.ts` (the interval from monthly and
  yearly events, kept, cleared and refused; the count with its positive
  control and exclusions), `provider/stripe.test.ts` and `provider/mock.test.ts`
  (the interval read and sent), `plan.test.ts` (the total and the starting
  count), and `billing-checkout.spec.ts` (the totals, the starting count).

### Team seats

Migration 334 (#641 Phase 5, "seats over the limit refused under parallel
invites"; Enforcement design, "Editors per catchment / Team seats").

- **One definition.** `app_team_seats_in_use(team)` is a team's editor
  seats in use: the distinct people who are its members or admins, or
  direct editors or owners of its projects. Its projects are those whose
  `team_id` is the team and those billed to the team's account; the
  `project_billing_account_set` trigger keeps the two the same (a project
  can't bill to a team account with `team_id` null), and the function takes
  both, so the count stays right if they ever part. Viewers, contributors
  and farmers hold no seat. `app_account_plan`'s `team.editorCount` is this
  number (334 redefines it from 332).
- **Paid seats.** The live subscription's `seats`, never fewer than the
  plan's `seats_included` (Team: 3), as the assistant allowance counts them.
  **A team with no live subscription (Free), or a live one on another plan,
  has no seat cap**: Team seats are the Team plan's limit; Free's editor
  limit is per catchment (`editors_per_project`, a later slice), and capping
  a Free team at Free's one included seat would lock every existing team.
- **The refusal.** Any change that gives someone a seat they don't already
  hold: adding a team member or admin or promoting a viewer, adding a
  project editor or owner or promoting one on a team's project, accepting
  an invite (each of these is a row in `team_member` or `project_member`),
  and moving a project into a team (its direct editors join the team's
  seats). Triggers on those tables check after the row is written, so every
  path (routes, `app_accept_invites`, `app_accept_invite`, the owner's own
  SQL) goes through one check, and an `INSERT … ON CONFLICT DO NOTHING` that
  inserts nothing is never refused. Someone already holding a seat (a member
  made admin, an editor made owner or added to another of the team's
  projects) costs none, so is never refused, even on a team over its seats
  after they were reduced. The API answers `402 plan_limit` with `{ limit,
  used, plan }` ([api.md § Billing](./api.md#billing)).
- **Parallel invites.** The check takes
  `pg_advisory_xact_lock(hashtext('billing:' || account))` and only then
  counts, in a fresh statement: two transactions granting the last seat
  wait for each other, the second counts the first's committed seat, and
  exactly one passes. Every write runs at READ COMMITTED (withUser's
  REPEATABLE READ transactions are READ ONLY), which this relies on.
- **Built but off.** It refuses only when `BILLING_ENFORCED=true`: `db/tx.ts`
  then sets the transaction-local `app.billing_enforced` to `on` at the start
  of every transaction (and sets nothing when off, so off costs no round
  trip). Nothing from a request reaches the setting. The committed dev and
  e2e env files leave it off.
- **Confirming an address.** `markVerified` accepts the person's pending
  invites inside a savepoint: if one would pass a Team's seats, they all stay
  pending and the address is still confirmed. Accepting on the invitations
  page then answers `402 plan_limit` until a team admin adds a seat
  ([§ Changing a Team's seats](#changing-a-teams-seats)) or makes someone a
  viewer.
- **Who sees it.** Only seat roles meet it, which a farmer never holds. The
  team and project member pages (workspace) show the server's English text;
  the Invitations page (`/account/invitations`), a translated page, words it
  from its code, so `plan_limit` is in `ERROR_CODES` with words in
  `frontend/src/lib/i18n/apiError.ts` (English and Afrikaans).
- **Tests.** `billing/teamSeats.db.test.ts` (the count and its exclusions,
  the app role refused the functions, off by default, refused on and passed
  after a seat is added, existing seat holders, a project moving in, a Free
  team, the invite left pending, any other refusal on confirming rethrown,
  a project billed to the team's account with no `team_id`, two parallel
  grants of the last seat), `auth/email-routes.test.ts` (`isPlanLimit`
  matches only the seat guard), `db/tx.db.test.ts` (the flag set only for
  `BILLING_ENFORCED=true`) and `http/errors.test.ts` (402 with only the
  numbers).

### Trials (decided 2026-11-23)

**Checkout sells no trial**: no `trial_period_days` and no
`subscription_data.trial_*`, for either plan. `plan.trial_days` (Pro 14,
Team 30) is the length of the trials #641 grants another way:

- **Pro: the reverse trial.** #641 "Free tier and abuse" → "Reverse trial:
  yes, 14 days" (accepted by the operator, 2026-10-29): every newly verified
  person gets Pro for 14 days automatically, no card, then Free, **once per
  canonical email**, and it *replaces* the opt-in 30-day trial (the
  "Recommended tiers" table strikes "30-day Pro trial, no card"). A Stripe
  trial at checkout would be a second Pro trial for the same person, behind
  a card, which the decision doesn't have. A card-on-file trial is
  escalation (c), only on its trigger (> 10% of trials from clusters, or
  trials using > 60% of the Free pool). The reverse trial is built, off by
  default: [§ The reverse trial](#the-reverse-trial-built-off).
- **Team: on request.** The "Recommended tiers" table's Trial row says
  "30-day Team trial on request": an operator decision per team, which is a
  staff plan grant (Phase 2, the staff grant), not a checkout option a team
  admin picks.

So the checkout's subscription starts `active` and charges at once; the
normaliser still reads `trialing` and `trial_end`, for a trial the operator
sets in Stripe's dashboard by hand. Revisit when escalation (c) triggers.

### The reverse trial (built, off)

`342_reverse_trial.sql`, `billing/reverseTrial.ts` (round 9 of #641). #641:
"Every newly verified person gets Pro for 14 days automatically, no card,
then Free … AI during the trial: Sonnet, $2 in all, $1 a day. It draws on
the Free pool … Once per canonical email."

**What is gated by what.**

| Piece | Gated by | Off (the default) |
| --- | --- | --- |
| Granting the trial on a first verification (`markVerified`, `auth/email-routes.ts`) | `REVERSE_TRIAL=true` **and** `BILLING_ENFORCED=true` (`reverseTrialOn`; only the exact string `true` for each) | Nothing is granted, and no claim is recorded, so turning it on later still gives each person their one trial |
| The trial's assistant caps (`trial`, `trial_day` refusals) | `BILLING_ENFORCED=true` (`app.billing_enforced`), as every dollar cap | Never refuse; the trial's dollars are still reserved and recorded |
| The expiry (the worker's tick, `app_reverse_trial_expire`) | Nothing: it ends any trial past its end | Finds none while none is granted |

Why both settings: a Pro trial means nothing while no limit refuses, and
granting it then would spend the person's once-per-email trial for nothing.

**Granting.** When an address is verified for the first time (the
verification link, a password reset that proves an unverified inbox, or a
sign-up through an invite for that address), the backend hashes the
address's canonical form (`canonicalEmail` in `billing/metrics.ts`:
lower-cased, `+tag` dropped, Gmail's dots dropped, googlemail.com as
gmail.com) with SHA-256 and calls `app_reverse_trial_start(hash)` as the
person, inside its own savepoint, so a trial that fails never fails the
verification, the password reset or the invite sign-up around it (logged as
`reverse_trial_start_failed`, the error's name and code only), and unless
the address is on a disposable domain (`auth/disposable.ts`,
[§ Verified email on Free](#verified-email-on-free)): then `disposable`, no
trial and nothing claimed. It answers `unverified` (no verified address: nothing claimed),
`live` (the account already has a live plan, a staff grant or a paid one:
nothing claimed, so the trial stays for later), `claimed` (this canonical
email had its trial, on this or any earlier account) or `started`. Started,
the person's own account has Pro as `trialing` for `plan.trial_days` (14):
a `subscription` with `provider = 'manual'`, `period_end = trial_end`,
`cancel_at_period_end` true (so the renewal notice skips it), logged in
`billing_grant_log` as a `grant` by `reverse trial`. A reverse trial is
exactly a `manual` + `trialing` row (staff and invoice grants are `active`,
Stripe trials are `stripe`). Only a verified address qualifies.

**Once per canonical email.** `reverse_trial_claim` keeps the SHA-256 of the
canonical address and when, never the address and no link to the account,
so it outlives the account's deletion: deleting the account and signing up
again gets no second trial (`security.md` § Personal information says what
the record is).

**At the end.** The worker's tick moves each trial past its `trial_end` to
`expired` and logs an `expire`; the account is then Free (no live
subscription) and nothing is deleted. The Plan page already reads
`subscription.trialEnd` and shows "Trial ends 7 Dec 2026" for a trialing
subscription (`components/billing/plan.ts` `subscriptionLine`).

**The pricing page and the trial** (decided 2026-11-24). The public
pricing page ([ui.md § Pricing page](./ui.md#pricing-page)) says "14 days
of Pro free when you sign up, no card needed. Then Free, unless you choose
a plan." on Pro, the number from `PLAN_FIGURES`' `trialDays`
(`packages/engine/src/plans.ts`, pinned to `plan.trial_days` by
`planFigures.db.test.ts`). The page is prerendered, so it can't ask the API
whether the trial is on: a build-time flag, `PUBLIC_REVERSE_TRIAL`
(`frontend/src/env.ts`, read by `reverseTrialDays` in
`components/pricing/pricing.ts`), shows the line only when it is exactly
`true`, as `REVERSE_TRIAL` reads. Empty in both committed env files, so the
page offers nothing today. The operator sets the repository variable
`PUBLIC_REVERSE_TRIAL=true` and releases the web in the same change that
turns on `REVERSE_TRIAL` and `BILLING_ENFORCED`, and unsets it (and
releases again) when turning them off ([deployment.md](./deployment.md)).
Rejected: reading `/billing/plans` from the page at load (the page would
show the line only after a request, flash on every visit and need the API
up for a static page), and leaving it off the page (the first thing a
visitor learns about the trial would be its end notice). The cost of the
flag: the two settings can disagree, so turning one on without the other
either offers a trial nobody gets or grants one the page doesn't mention;
the variable's row in deployment.md says to move them together.

**What the pages show** (349, round 2026-11-24). The plan JSON marks a
reverse trial: `subscription.reverseTrial` is true for a `manual` +
`trialing` subscription (`billing/entitlements.ts` `accountPlan` asks
`app_billing_live_subscription_ref` for the provider of a trialing one;
false for a staff grant or a Stripe trial). During one the Plan page offers
**Upgrade** rather than Manage billing (`plan.ts` `billingActions`), since
checkout replaces the trial (below). In the trial's last 3 days (the
trial-ending email's window, [§ Plan emails](#plan-emails)) a note on the
Plan page, and one in the workspace header beside the paused notice, says
when it ends, that the account then moves to Free with nothing charged or
deleted and nothing paused for 14 days, and offers Upgrade
(`components/billing/trialEnding.ts`). The workspace reads the project's
`planTrialEnd` (`349_project_trial_end.sql`, `app_project_trial_end`): the
trial end of the account the catchment is billed to, only for that
account's person or a team admin (`app_billing_account_readable`), so a
member never sees someone else's trial. All of it is inert while
`REVERSE_TRIAL` is off: no trial row exists. Tests:
`billing/trialBanner.db.test.ts`, `entitlements.test.ts`, the frontend's
`plan.test.ts`, `trialEnding.test.ts` and `planPause.test.ts`, and e2e
cases in `billing-checkout.spec.ts` and `billing-keep-live.spec.ts`.

**The trial's assistant.** Pro's month applies, and on top, during a reverse
trial, `app_assistant_begin` refuses (enforced only):

| Cap | Limit | Refusal (`429`, `Retry-After`) |
| --- | --- | --- |
| Trial | $2 over the whole trial (`assistant_trial_caps`, `TRIAL_CAPS`): the account's day rows from the trial's first SAST day on, plus its open reservations | `assistant_trial_cap`, until the trial ends |
| Trial day | $1 a SAST day: the person's day on the account | `assistant_trial_daily_cap`, until 00:00 SAST, or the trial's end if sooner |

The trial is checked before its day, so a spent trial never says "back
tomorrow". A trialing account is in the Free pool (336's
`assistant_pool_account`), so the pool's month and paced day bind it too and
its spend counts toward the pool. The caps are fixed in SQL, not settings:
#641 states them, and a DB test (`reverseTrial.db.test.ts`) pins the SQL pair to
`TRIAL_CAPS`.

**Buying Pro during the trial** (`344_trial_checkout.sql`, round 10).
Checkout opens for an account whose only live subscription is its reverse
trial ([§ Checkout and portal](#checkout-and-portal)). When the paid
subscription's webhook lands, `app_billing_apply` ends the trial in the same
transaction, before it writes the paid row: `expired` (as the tick ends
one), its `period_end` and `trial_end` moved to now (never before it began),
logged as an `expire` by `checkout`. So the one-live index holds and the
account goes from the trial straight to the paid plan, never through Free.
Only a live (`trialing`, `active` or `past_due`) Pro or Team subscription
from a payment provider (`mock` or `stripe`) ends a trial; a `manual` event,
and any other live subscription already there (a staff or invoice grant, a
paid plan), is still a `conflict`. A replay is a duplicate (326), and a
later update to the paid plan finds no trial to end. The claim stays: the
person had their trial. 344 also takes the account's billing lock (334's
advisory lock) before the account row's `FOR UPDATE`, as 341 and 342 do,
since every subscription write fires 341's sync, which takes it.

**3 days before the end** the person gets an email ([§ Plan emails](#plan-emails)).

**On the pages** (round 2026-11-24): the Plan page's Upgrade during a trial
and the 3-day note on the Plan page and in the workspace are above (§ What the
pages show). Still open ([followups.md § Billing](./followups.md#billing-issue-641)):
whether to key `reverse_trial_claim` with an HMAC (operator decision). The assistant panel shows the two trial codes as caps,
with the server's words and when they're back, never an upsell (the trial is
Pro already), and its day meter counts the trial's day and its whole $2
([§ Assistant dollar caps](#assistant-dollar-caps)).

**Tests.** `billing/reverseTrial.db.test.ts` (off grants and claims nothing;
on, a first verification starts 14 days of Pro, logged and on the plan page;
a Gmail canonical duplicate and the same address after deletion get none; an
unverified caller gets none and is granted once verified; a live plan keeps
it; the tick ends it to Free with the project still there; the claim table
closed to `water_app`; the trial caps refuse only enforced, wait to 00:00 SAST
or the trial's end, ignore spend before the trial, and count in the pool),
`billing/trialCheckout.db.test.ts` (344: mock checkout during the trial, then
the webhook: Pro paid and live, the trial expired now and logged, one live
plan; a replay is a duplicate; a provider's own trialing ends it too; a
staff grant still refuses checkout and the paid event; a `manual` or Free
event never ends a trial), `billing/checkout.test.ts` (`checkoutBlockedBy`),
`billing/reverseTrial.test.ts` (the setting, the hash), `assistant/dollarCaps.test.ts`.

### Stripe

Three form-encoded POSTs over `fetch` (`provider/stripeApi.ts`):
`/v1/customers` (metadata `billing_account_id`, idempotency key per account),
`/v1/checkout/sessions` (subscription mode, the stored customer,
`client_reference_id` the account, and `metadata` plus
`subscription_data.metadata` with `billing_account_id`, `plan_code` and
`seats_included`, which the webhook's normaliser reads; Team's extra seats
as a second line item, § Team seats at checkout), and `/v1/billing_portal/sessions`. Each
pins `Stripe-Version: 2026-10-28.endive`, has a 15 s timeout, and accepts
only an `https://…stripe.com/` URL back.

The price is inline (`price_data`: the plan table's minor units, currency
and interval, product name `IC-WBT <plan>`), so `plan` stays the one source
of prices and nothing has to be set up in Stripe's dashboard first. The
catch: Stripe's portal can switch plans only between Prices it knows, so
plan switching there waits for Prices made in the dashboard (the portal
still handles card updates, invoices and cancellation).

`STRIPE_SECRET_KEY` is read from the environment only. The production check
refuses `stripe` without a live key (`sk_live_…` or `rk_live_…`). In
production it comes from the API's runtime secret, beside
`BILLING_WEBHOOK_SECRET`, once Terraform's `billing_provider` is `stripe`
([deployment.md § Turning on Stripe](./deployment.md#turning-on-stripe)). Locally the key is never set: the mock needs none, and the unit
tests mock the HTTP layer (`stripeApi.test.ts`, `provider.test.ts`); nothing
in the repo calls Stripe for real.

### The mock

The mock's checkout is a page on the API that asks which outcome to
simulate, as #641's "Local-first" asks (`billing/mockCheckout.ts`):

Each button is named for what it simulates (*Simulate: pays*, …):

- **Pays**: `checkout.session.completed` and `customer.subscription.created`
  (active, a month or a year from now, subscription id `sub_mock_<account>`,
  with Team's extra seats as a second item),
  each signed with the dev key and posted to `POST /billing/webhook/mock`
  in-process: the real route, so `app_billing_apply` writes the
  subscription, as with Stripe. Then `303` to the plan page with
  `?checkout=done`.
- **Declines**: the page again, saying the card was declined, nothing sent
  (Stripe's hosted page keeps the person there too).
- **Cancels**: `303` back with `?checkout=cancelled`, nothing sent.

The mock portal shows the subscription by its plan's name and offers *Cancel
at the end of the period* (`customer.subscription.updated` with
`cancel_at_period_end`, through the webhook the same way) and a link back.
The *This page has expired* page (a stale or forged token) and the
*Something went wrong* page (the webhook refused an event) each link back to
the plan page.

**Where the pages live, and why.** On the backend, as plain HTML forms with
no script, rather than an SPA route: the outcome is an event signed with
`BILLING_WEBHOOK_SECRET`, which must stay on the server. A backend page signs
and posts in the same process; an SPA page would need a dev-only API to do
the same and would ship its code in the production bundle. Every mock route
answers `404` unless `BILLING_PROVIDER=mock`, which production refuses.

**The token.** A mock session is not a row: it is the account, the plan,
interval and price (checkout) or the subscription to change (portal), the
return URLs and an expiry (an hour), as base64url JSON with an HMAC-SHA256
under the dev key and its own context string (`provider/mock.ts`), so it is
never a valid webhook signature and can't be pointed at another account
(`checkout.db.test.ts`). The forms post their choice in the action's query,
so no body is read. The two POSTs are exempt from the CSRF check (`app.ts`),
like `/alerts/unsubscribe`: they come from the API's own origin, which isn't
a site origin, read no session, and act only for the token's account.

### Which HTTP client: research (2026-11-23)

The question: call Stripe's API with the `stripe` npm package or plain
`fetch`? **Decision: `fetch`.**

- **The estate.** threkir uses `npm:stripe@23.1.0` on Supabase Edge
  Functions (`apps/backend/supabase/functions/_shared/stripe.ts`), where it
  calls many resources and boots from npm anyway. feohledger's billing doc
  is where the signature and provider-name lessons above come from.
- **Size.** `stripe@23.1.0` has no dependencies but unpacks to 18.3 MB
  (`npm view stripe@23.1.0 dist.unpackedSize`). Bundled for Node with
  esbuild, minified, an entry that creates one Checkout session came to
  246 KB (34 KB gzipped), all of it in the API Lambda's bundle for three
  POSTs that take about 120 lines here.
- **API version.** The SDK pins one version per release (23.1.0:
  `2026-10-28.endive`, its `apiVersion.js`) and moves it on a major bump;
  here `STRIPE_API_VERSION` is the same string, sent as `Stripe-Version` on
  every call, and changes only on purpose, with the normaliser's tests
  ([Stripe: versioning](https://docs.stripe.com/api/versioning),
  [Stripe: upgrades](https://docs.stripe.com/upgrades)).
- **Dependabot.** It would watch the package, but a bump that moves the API
  version is a behaviour change to review, not a patch to merge; with
  `fetch` there is no dependency to watch, and the version is a constant in
  one place.
- **Webhook types.** The SDK's event types would not replace the
  normaliser: it reads fields across API eras (the period on the item since
  `2025-03-31.basil`, the invoice's `parent.subscription_details`), which
  one pinned type set doesn't describe; the normaliser's tests pin each
  field. Its `constructEvent` would replace `provider/signature.ts`, which is
  already built and tested.
- **What `fetch` costs.** No retries with backoff (a person clicking a
  button retries; the customer call carries an idempotency key, so a retry
  can't make a second one) and no response types (only `id` and `url` are
  read, each checked by shape).

Revisit if the backend comes to call many Stripe resources (refunds,
invoices, usage records), where the SDK's coverage would outweigh its size.

### Tests

- `billing/provider/stripeApi.test.ts`: what each Stripe call sends (path,
  headers, form body; Team's second line item and no trial) and how answers
  and errors are read, with `fetch` mocked.
- `billing/provider/stripe.test.ts`: Team's seats from a two-item
  subscription (`subscription-team-seats`, in either order), one item, and a
  bad `seats_included`.
- `billing/provider/mock.test.ts`: the token (forged, expired, other key,
  not a webhook signature) and that the mock's events normalise to the
  account, plan and seats.
- `billing/provider.test.ts`: each provider's checkout and portal, and the
  coded refusals.
- `billing/checkout.test.ts`: the routes and the mock pages with the
  database mocked: 401, 404, the plan per account kind, the seats (Team's
  price, the range, Pro's one), 409, 503, and that pays posts two signed
  events to the webhook.
- `billing/checkout.db.test.ts`: who may start checkout (positive control,
  and 404 to a member, viewer, farmer and stranger), a mock checkout that
  pays ends with the subscription live through the webhook and
  `app_billing_apply`, a Team checkout of 5 seats ends with `seats = 5` (and
  a 5 × $15 assistant allowance), the portal's cancel, a forged token, and
  328's functions.
- `frontend/src/lib/components/billing/plan.test.ts`: the seat field's
  range and the buttons' price for the seats chosen.
- `billing/seats.test.ts` (the route: 401, 404 before any provider call,
  the 409s with a grant's and manual's codes, the seat range and strict
  body), `billing/provider/seats.test.ts` (Stripe's requests to update, add
  and remove the extra-seat item, with the proration and idempotency key;
  the mock's event read back as the seats; manual refused) and
  `billing/seats.db.test.ts` (a mock Team at 3 seats changed to 5 ends with
  5 through the webhook, and back; 404 to a member and a stranger; 333's
  access). `frontend/src/lib/components/billing/seatChange.test.ts` (the
  confirm step's words) and `e2e/tests/billing-seats.spec.ts` (the control,
  its confirm step, and the new count on the page).
- `e2e/tests/billing-checkout.spec.ts`: the plan page's buttons, Team's seat
  field, and the mock checkout and portal in a browser.

## Live catchments (Free)

Free never rations modelling; it limits operations to one catchment (#641,
operator 2026-10-29: "live feeds + automatic runs + alerts + published farm
views (1 catchment)"). The plan's `live_catchments` limit is 1 on Free and
null (unlimited) on Pro and Team (323). Migration 338 defines it and refuses
a second one when `BILLING_ENFORCED` is on.

- **What live means: derived, no flag.** A project is live when it has any
  of: an enabled `data_feed`, an enabled `alert_rule`, automatic runs on
  (`settings.autoRun.enabled`, 042's test) or a publication (any
  `run_publication`: publishing supersedes the old one but keeps it, and
  farm views stay up with their last publication). Why derived rather than
  a flag the owner sets: "the owner picks the one live catchment" is
  already what switching those on does, and a separate flag could disagree
  with what is actually running (a feed fetching in a catchment marked not
  live). The owner moves the live catchment by switching its feeds, alerts
  and automatic runs off there (or, after a lapse, by choosing the one to
  keep: [§ Choosing the catchment to keep](#choosing-the-catchment-to-keep)); a publication can't be taken back, so a
  catchment that published stays the live one. After a downgrade, or a
  reverse trial's end (a lapse like any other), 341 pauses the others'
  operations after a 14-day grace, deleting nothing ([§ Pausing after a
  downgrade](#pausing-after-a-downgrade)); the Plan page's picker for which
  one stays live is still to build ([followups.md](./followups.md)).
- **One definition.** `app_project_live_except(project, …)` (whether a
  project is live through anything but the named row) and
  `app_live_catchments_in_use(account)` (its billed projects that are live).
  Owner-only, like 334's seat functions.
- **The refusal.** AFTER triggers on `data_feed` and `alert_rule` (insert, or
  `enabled` turned on), `run_publication` (insert) and `project` (automatic
  runs off to on) call `app_live_catchment_guard(project)` only when the
  change makes a project live that wasn't. It takes 334's
  `pg_advisory_xact_lock(hashtext('billing:' || account))`, reads the plan
  (no live subscription = Free), counts, and raises `plan_limit` past the
  limit. Every path (routes, the alert rules' own `ensure*` helpers, the
  owner's SQL) goes through it. Two parallel switches in two catchments:
  exactly one passes.
- **Never switched off.** A change in a catchment already live is never
  refused, even on an account past its limit (live before enforcement, or
  after a downgrade), and nothing already on is turned off. Pausing
  operations on the other catchments after a downgrade's 14-day grace is
  [§ Pausing after a downgrade](#pausing-after-a-downgrade).
- **Copy and import start not live (340).** A copy or an import of a
  catchment with automatic runs on is never refused (refusing would ration
  copying and importing, which Free never limits). With enforcement on and
  the account's live catchments all in use, the new project starts with
  automatic runs off instead (`project_live_start_off`, a BEFORE INSERT
  trigger on `project` that fires after `project_billing_account_set`, under
  the same account lock), its other automatic-run fields kept, and the
  answer says so (`autoRunsOff: "live_catchments"`, [api.md](./api.md)).
  The copy dialog and the import dialog show it in their done state: one
  information line saying why, with *Compare plans*
  (`AutoRunsOffNotice.svelte`; [ui.md § Project list](./ui.md#project-list)).
  The empty list's *Start from an example* shows the same line on its card
  and waits for *Open the example* rather than opening the project (the
  shipped example has automatic runs off, so this only guards one that
  gains them).
  Automatic runs are the only way a new project is live: a copy leaves feeds
  with the original and copies no alert rules or publications, and an import
  has none. Below the limit, or with enforcement off, the copy keeps them on.
- **Moving to another account (340).** A live catchment moving into or out
  of a team (`PATCH /projects/:id` with `teamId`, which moves its billing
  account) is checked against the new account's limit
  (`project_move_live_guard`, AFTER UPDATE OF `team_id`, `billing_account_id`,
  calling 338's guard): a move that would give a Free account a second live
  catchment answers the same `402`. A catchment that isn't live moves
  freely.
- **The answer.** `402 plan_limit` with `{ limit: 1, used, plan: 'free',
  key: 'live_catchments' }` and fixed words ([api.md §
  Billing](./api.md#billing)). The numbers keep 334's shape (`limit` the
  plan's number); `key` names which limit, so the seat refusal (no `key`)
  is unchanged. Only from the workspace's switches: farmer pages never
  switch operations on.
- **In the workspace.** The Data feeds panel (attaching or switching a feed
  on) and the alert rules editor show it as an information note, not an
  error (`LiveLimitNotice.svelte`, `liveLimit.ts` in
  `frontend/src/lib/components/billing/`), in #641's tone (no "quota" or
  "402"), with *Compare plans* linking to the Plan page of the account that
  bills the catchment: a team catchment's team (`/teams/:id/plan`), any
  other the person's own (`/account/plan`; [§ Who the plan belongs
  to](#who-the-plan-belongs-to)). Every Compare plans link (this note, the
  copy and import dialogs' line, the assistant's cap, the paused and
  trial notices) builds it with `planLink` (`planLink.ts`) from
  `project.team` and the caller's `team.role`, which the workspace provides
  to the components below it: the team's plan only for a team admin, else
  the price list with "ask a team admin" (§ Who the plan belongs to). The note also shows in
  the settings save bar (automatic runs; `SaveBar.svelte`, from the settings
  draft's `liveLimit`, the edit kept unsaved) and the Publish this run
  dialog (`PublicationPanel.svelte`, the dialog kept open), each in place of
  the error line (340's round, issue #641 round 9).
- **On the Plan page.** `app_account_plan` (340) returns
  `usage.liveCatchments { used, limit }` from `app_live_catchments_in_use`,
  and Plan and usage shows it as the *Live catchments* row after
  *Catchments* ("1 of 1 · At the limit"; "Unlimited" on Pro and Team; past
  the limit, after a downgrade or from before enforcement, the warning
  colour, as every row). The row is left out when an older API doesn't send
  it (the web and the backend release apart).
- **Tests.** `backend/src/billing/liveCatchments.db.test.ts`: off, two
  catchments go live; on, each route (feed, alert rules, automatic runs)
  and a publication is refused in a second catchment and passes in the
  first; switching the first off frees the slot; past the limit nothing is
  refused in a live catchment; Pro is never refused; the race. 340's: a
  copy and an import at the limit start with automatic runs off and say so
  (positive controls: below the limit, and off, they stay on); a live
  catchment moving into a Free team with its live one is refused, one that
  isn't live moves; the Plan's `usage.liveCatchments`. Frontend:
  `plan.test.ts` (the row), `settingsDraft.test.ts` (the note cleared);
  e2e: `settings-page.spec.ts` and `publication.spec.ts` (the 402 mocked
  with `page.route`).

## Pausing after a downgrade

`backend/migrations/341_plan_pause.sql` (issue #641 § Downgrade or lapse).
Built but off: nothing is paused unless `BILLING_ENFORCED` is on.

- **When.** An account that has had a subscription (paid, trial or staff
  grant) and now has none live (canceled, expired, a lapsed grant) is on
  Free. If it then holds more live catchments than Free's
  `live_catchments` (338's derived "live"), `billing_account.over_free_since`
  records when that was first seen: the subscription trigger stamps it as
  the plan ends, and the job tick (`app_plan_pause_tick`, every 5 minutes)
  catches any path the trigger misses. An account that never had a plan is
  never paused (its extra live catchments predate enforcement). A reverse
  trial's end (342, `app_reverse_trial_expire`) is a lapse like any other,
  so it starts the same grace. Auto-calibration on new data isn't paused:
  it refits a model, which is modelling, and Free never limits modelling.
- **The grace.** For 14 days nothing changes. After them, with billing
  enforced, the tick pauses every live catchment past Free's limit and keeps
  one: the one the owner chose (`billing_account.kept_project_id`, set by
  `app_billing_keep_catchment(project)`, the account's person or a team
  admin; the pause moves at once), else the most recently active (the
  project's `updated_at` or its newest run).
- **What a pause is.** A marker row, `project_plan_pause`, and nothing else:
  the catchment's feeds, alert rules and automatic-runs setting stay exactly
  as the user left them, and nothing is deleted. The feed scheduler
  (`app_due_feeds`), the automatic re-run (`app_enqueue_rerun`), the forecast
  run (`enqueueForecastRun`) and the alert checks (`app_alert_schedule`,
  `alertsOn`) pass a paused catchment by. Everyone can still read, export,
  run and edit it (Free never limits modelling), and its published farm
  views stay up with their last publication. `app_project_plan_paused(project)`
  answers when it was paused, or null.
- **Resuming.** A live subscription again (the subscription trigger, at
  once), switching the extra catchments' operations off so the account is
  back within Free, or enforcement turned off: the markers go and the grace
  ends. Everything runs again as it was.
- **The owners are told** when the grace starts and when the pause lands
  ([§ Plan emails](#plan-emails)).
- **In the workspace.** A paused catchment's section header says so in its
  notice line, an information note, not an error (`project.planPausedAt` on
  `GET /projects/:id`; `billing/planPause.ts`): its feeds, alerts and
  automatic runs are paused since that date because the plan it is billed to
  ended, nothing is lost, and a link to the plan (the team's Plan page for a
  team catchment, else *Plan and usage*). Every member sees it.
- **Tests.** `backend/src/billing/planPause.db.test.ts`: the grace recorded
  on a lapse and nothing paused within it; nothing paused with enforcement
  off; past it, enforced, two of three catchments paused, the most recent
  kept, nothing deleted or switched off; the paused one's feeds, re-runs,
  forecast run and alert checks skipped and the kept one's still scheduled
  (positive control); members read the marker, strangers don't; the owner's
  choice moves the pause and a stranger's is refused; an upgrade resumes
  everything; a never-paid account isn't paused; only the worker sweeps.

## Plan emails

`346_billing_notices.sql`, `billing/planNotices.ts`, `planNoticeMail` in
`mail/templates.ts` (keys `mail.plan.*` in `backend/src/mail/i18n/en.ts`,
with Afrikaans). #641: after a downgrade "automatic runs and alerts … stop
after a 14-day grace, with an email to the owners", and the reverse trial's
end is announced. Three emails, each **once** per occurrence and recipient,
sent by the worker's tick after the pause sweep:

| Email | When | Gated by | Says |
| --- | --- | --- | --- |
| Grace started (`grace`) | An account has `over_free_since` (341: a paid plan, trial or grant ended with more live catchments than Free's) and the 14 days are still running, nothing paused yet | `BILLING_ENFORCED=true` | The date the pause lands (`over_free_since` + 14 days, SAST), the catchments that will pause, the ones that stay on, that nothing is deleted and everything stays readable, editable, runnable and downloadable, and how to keep another one on or upgrade (the plan page) |
| Pause landed (`paused`) | A catchment of the account is paused (`project_plan_pause`) | `BILLING_ENFORCED=true` | The catchments paused, the ones on, nothing deleted, how to resume |
| Trial ending (`trial_ending`) | A reverse trial (342: `manual` + `trialing`, a person's account) ends within 3 days | A trial existing (342 grants none unless `REVERSE_TRIAL` and `BILLING_ENFORCED` are on) | The plan and the end date, that nothing is charged (no card), nothing deleted, the 14-day grace if more catchments are live than Free's, and the plan page |

With enforcement off nothing pauses (341), so no grace or pause email is
queued: it would announce something that won't happen. A grace first seen
already past its 14 days (enforcement turned on late) gets only the pause
email. A Stripe trial isn't emailed here: Stripe sends its own reminder.

**Who.** The account's owners, those who may change its plan
(`app_billing_account_readable`, 323): the person for a personal account,
each admin of the team for a team's. Each gets their own email, in their
language.

**Once.** `billing_notice`'s primary key is (account, kind, `about`,
recipient), `about` being the occurrence: `over_free_since` for the grace
and pause emails (a later lapse is a new grace with new emails), `trial_end`
for the trial's. Queueing is `ON CONFLICT DO NOTHING`; claiming is under
`FOR UPDATE SKIP LOCKED` with a lease; a send error retries on the next tick
(3 attempts); a worker that dies mid-send leaves it `failed`, never sent
twice (329's pattern). The rows are kept as the record that the email went,
go with the account and with the person, and are in the person's data export
(`billing.planNotices`).

**Built as the recipient.** Each email is built in a read-only transaction
as its recipient, under RLS: the account is read again as they see it (an
email whose grace is over, back on a plan or within Free, whose pause has
lifted, whose trial ended or was replaced, or with enforcement now off, is
`skipped`, as is one to an unconfirmed or suppressed address). What pauses
comes from `app_plan_pause_preview(account)`: 341's order (the kept one,
else the most recently active), for the account's owner only, with no id for
a catchment the caller can't read (a catchment they left, still billed to
their account; a team catchment they're not a member of). The email names
only the catchments the recipient can read and counts the rest ("and 1 more
catchment of the account that you are not a member of"). The log lines
(`plan_notice_sent`, `plan_notice_skipped`, `plan_notice_prepare_failed`,
`plan_notice_queue_failed`) name the account id and the kind only.

**Tests.** `billing/planNotices.db.test.ts` (off sends and queues nothing;
enforced, the grace email goes once, with the date, the catchments to pause,
the kept one, and the one the owner left counted, never named, and nobody
else emailed; the pause email once and no second grace email; the trial
email once at 3 days, not at 5, not for a staff grant, even with enforcement
off; a trial replaced before the send is skipped; the preview answers the
owner and not a stranger; only the worker queues, claims and finishes),
`mail/templates.plan.test.ts` (the SAST date under the skewed `TZ`, the
team's name, the count, Afrikaans), `mail/outbound.security.test.ts`.

### Choosing the catchment to keep

`backend/migrations/345_plan_keep_picker.sql`, the Plan page's picker over
341's choice.

- **The list.** `GET /account/plan/live-catchments` (your account) and `GET
  /teams/:id/plan/live-catchments` (a team admin; 404 to anyone else) read
  `app_billing_live_catchments(account)`: Free's live limit, when the account
  went past it with its plan ended (`overFreeSince`, the grace's start; null
  within it or never on a plan) and `pausesFrom` (14 days on), and each live
  catchment in 341's order with its name, whether the owner chose it, whether
  it stays live and when it was paused. It names every catchment billed to
  the account, whoever's project it is: the account pays for them, and its
  owner can only choose among what they can name.
- **The choice.** `POST …/plan/keep { projectId }` calls
  `app_billing_keep_live(account, project)`: false (the route's 404) unless
  the caller may read the account and the project is one of its live
  catchments; else 341's `app_billing_keep_catchment`, under the account's
  lock, and the pause moves at once (past the grace, enforced). It answers
  the list as it now stands.
- **On the Plan page.** On Free past its live catchments (`usage.liveCatchments`
  over its limit, no live subscription), Plan and usage reads the list, and
  once the plan has ended (`overFreeSince`) shows a *Live catchments* card
  (`KeepLive.svelte`, words from `plan.ts`): what Free keeps live, what pauses
  on the others and when (or that it already has; with limits not yet
  enforced, that it would), that nothing is lost, each catchment's state, and
  *Keep live* on each other one, asked through the app's confirm dialog. An
  account that never had a plan sees no card.
- **Tests.** `backend/src/billing/keepPicker.db.test.ts` (the owner lists and
  chooses and the pause moves, enforced past the grace; a stranger, a team
  member and a project that isn't live all get 404; a bad body 400; every
  member reads `planPausedAt`); `plan.test.ts` and `planPause.test.ts`; e2e
  `billing-keep-live.spec.ts` (the API answered with `page.route`, since e2e
  can't reach a pause).

## Verified email on Free

Issue #641 § Free tier and abuse, items 1 and 4 (decided): "the assistant
and live feeds need a verified email", and item 5, no disposable addresses.
Built in round 9, **off unless `BILLING_ENFORCED` is on**: no setting of its
own, since #641 makes it a Free limit like the rest, and Phase 2 switches
them on together.

- **What it refuses.** On a project whose billing account has no live
  subscription (Free; trialing, active and past-due accounts are never
  gated, as 338 counts them), the caller can't start an assistant turn
  (`POST …/assistant/messages`) or switch a data feed on (`POST
  …/feeds` with the feed enabled, or `PATCH …/feeds/:feedId` taking it from
  off to on) while their email is unverified (`403 email_unverified`) or on
  a disposable domain (`403 email_disposable`). The gate is the caller's,
  whatever their role: an unverified viewer on a verified owner's Free
  project is refused the assistant. Attaching a feed switched off, saving a
  feed already on, a project with no billing account, and every route that
  isn't one of those three are never refused. The refusal comes after the
  role check (a non-member still gets 404) and before anything is counted
  or reserved.
- **Where.** `backend/src/billing/emailGate.ts` (`requireFreeVerifiedEmail`),
  called from `assistant/routes.ts` before `beginTurn` and from
  `feeds/routes.ts`; whether it applies comes from `app_free_email_gate`
  (343_free_email_gate), a definer function run as the caller, since
  `app_entitlements` hides the plan below editor. It answers NULL unless
  billing is enforced and the caller is a member of a project on Free, and
  then only the caller's own address and whether it is verified.
- **Reachability.** An unconfirmed account can't sign in (issue #57), so
  `email_unverified` is defence in depth for sessions made before that rule;
  `email_disposable` is the one an ordinary account meets.
- **The blocklist.** `backend/src/auth/disposable.ts` (`isDisposable(email)`,
  `isDisposableDomain(domain)`): a domain or any parent of it on the
  vendored CC0 `disposable-email-domains` list
  (`backend/src/auth/disposableDomains.ts`, its source, commit, date,
  licence and hash in the header; [data-sources.md §
  disposable-email-domains](./data-sources.md#disposable-email-domains)).
  Never fetched at runtime; refreshed monthly by a PR from
  `.github/workflows/disposable-domains.yml` (`pnpm gen:disposable-domains`,
  a ±20 % size-change guard). The reverse trial (a disposable address gets no
  trial), sign-up and an email change all call it (the round 10 bullet below).
- **The words.** Workspace English, #641's copy: "Verify your email to use
  the assistant. We sent a link to name@example.com." with *Resend* (the
  feeds panel's says "switch on a live data feed"); a disposable address:
  "To use the assistant on the Free plan, you need a permanent email
  address. This one is from a temporary-mail service." An information note,
  not an error colour (`EmailGateNotice.svelte`, `emailGate.ts` in
  `frontend/src/lib/components/billing/`), in the assistant panel's foot and
  the Data feeds panel. The API's own words carry no address; the panel
  shows the signed-in person's.
- **Counted.** Each refusal is logged (`email_gate_refused`, its code and
  feature, never the address or domain) and counted per SAST day in
  `email_gate_refusal` (348) for the abuse report
  ([§ Metrics and the abuse report](#metrics-and-the-abuse-report)). The
  count is written once the route's transaction has ended
  (`EmailGateRefused` and `countGateRefusals` in `billing/emailGate.ts`); a
  failed count still answers 403. A test runs a refusal on a pool of one
  connection and checks it answers promptly and is counted.
- **Tests.** `backend/src/billing/emailGate.db.test.ts` (off allowed; on,
  unverified and disposable refused for the assistant and for attaching and
  switching on a feed; verified, paid and attached-off allowed; a
  non-member's 404; the function's answers; each refusal counted once on
  the SAST day and logged with no address),
  `backend/src/auth/disposable.test.ts`,
  `scripts/guards/disposable_domains.test.mjs` (the refresh),
  `frontend/src/lib/components/billing/emailGate.test.ts`, and the assistant
  panel's and chat's tests.

- **Sign-up and changing the address (round 10).** With `BILLING_ENFORCED`
  on, sign-up refuses an address on a disposable domain (`400
  signup_disposable`, `auth/routes.ts` `/register`, after the sign-up
  throttle and before the address is looked up, so it tells nothing about
  accounts), and so does changing the address (`400 email_change_disposable`).
  Off, both take any address, like every other Free rule: #641 builds
  anti-abuse into Phases 1–2 and Phase 2 switches the limits on together.
  A sign-up through a live invite for exactly that address is exempt:
  invitees are farmers and viewers a catchment's manager chose, always free
  (changing the address afterwards is still refused). A person refused here, or by the
  gate above, fixes it on the Account page's **Email address** card (POST
  `/auth/change-email`): a link goes to the new address and the account
  switches only when it is used ([security.md § Changing the email
  address](./security.md#changing-the-email-address)). Changing a verified
  address never starts a reverse trial (`markVerified` runs only for an
  account that was never verified), so a new address can't mint one.

## Staff grants

`backend/migrations/330_staff_grant.sql`, `backend/scripts/billing-grant.ts`
(issue #641, "Staff overrides"). The operator's tool for manual plans: the
first client's deal, founding users (Q4's grandfathering), and **v1 B2B
invoices**. A business that pays by invoice gets a Stripe invoice: one from
the staff tool ([§ B2B invoices](#b2b-invoices)) grants its plan itself when
it is paid; for one sent from the Stripe dashboard the operator grants the
plan by hand, once it is paid, until the end of the invoiced period. It
works with `BILLING_PROVIDER` unset.

```bash
pnpm dev:billing:grant <email|team-id> <plan> [--until YYYY-MM-DD] --reason "…" [--replace] [--by <name>]
pnpm dev:billing:grant <email|team-id> --revoke --reason "…" [--by <name>]
pnpm dev:billing:grant <email|team-id> --list
```

It runs as the schema owner on this checkout's database (like
`dev:billing:report`); in production the operator runs the same code
(`backend/src/billing/staffGrant.ts`) through the migrate Lambda's owner
actions `billing-grant`, `billing-revoke` and `billing-grants`
(`.github/workflows/billing-admin.yml`, approved in the `production`
environment, with the run's GitHub login as `--by`; [deployment.md § Owner
actions](./deployment.md#owner-actions)), or, as a fallback, the functions
in SQL step by step in [deployment.md § Runbooks](./deployment.md#runbooks)
21. The workflow takes ids only (a billing account's, a person's or a
team's), never an address: its runs are in a public repo, where a run's
inputs may be visible ([security.md § Public repo
hygiene](./security.md#public-repo-hygiene)). The operator finds the id
through the `billing-account` lookup, invoked from their own SSO session
(deployment.md § Owner actions). The Lambda's answer carries ids, never the
address, and the workflow's public summary leaves out the reasons. An
address is used only to find the person's account (the local script and
that direct invoke) and is printed only as the operator typed it. `--by`
defaults to the operator's login.

- **What a grant is.** `app_staff_grant_plan(account, plan, until, reason,
  by, replace)` writes a `provider = 'manual'`, `status = 'active'`
  subscription (no `external_ref`) and a `grant` row in `billing_grant_log`.
  `--until` is a South African date: the grant lasts through it and ends at
  the next SAST midnight, whatever the machine's time zone. Without it the
  grant lasts until revoked. With an end, `cancel_at_period_end` is true, so
  the plan page says it ends and the renewal notice never picks a grant up.
  `free` can't be granted (revoke instead), the end must be in the future and
  a reason (≤ 500 characters) is required.
- **Beside a live subscription.** A live **Stripe** subscription is refused,
  with or without `--replace`: ending it here would leave Stripe billing the
  customer for a plan we no longer show, and `app_billing_apply` never
  revives a canceled row. Cancel it in Stripe; the webhook ends it; then
  grant. A live **mock** or **manual** one is refused unless `--replace`,
  which cancels it now (a replaced grant gets a `revoke` row, reason
  `replaced: …`). The same holds the other way: while a grant is live, a
  Stripe checkout's `subscription.created` is a `conflict` (the one-live
  index), so revoke the grant before the customer moves to a card.
- **Expiry.** The worker's tick runs `app_staff_grant_expire()` (worker
  context only): every live grant whose `period_end` has passed becomes
  `expired` and gets an `expire` row (`granted_by = 'expiry'`). The account is
  on Free again, with nothing deleted. "Live" stays 323's status test, so a
  grant can outlive its end by one tick (5 minutes in production; locally,
  until a worker runs). A new grant first expires the account's lapsed one,
  so a late tick never blocks it.
- **Revoke.** `app_staff_revoke_grant(account, reason, by)` cancels the live
  grant now (`period_end` now) and logs a `revoke` row; Free again, nothing
  deleted. It never touches a Stripe or mock subscription.
- **The log.** `billing_grant_log` is append-only (`water_app` holds SELECT
  only; only these functions insert). The account's person and its team's
  admins read their own rows under RLS (`app_billing_account_readable`), and
  the person's are in "Download my data" (`billing.grants`). That is
  deliberate: it is the record of their own plan, so **write the reason for
  the customer to read** (an invoice number, "founding user"), never a private
  note. `granted_by` (the operator's name) is visible to them too.

Tests: `backend/src/billing/grant.db.test.ts` (grant and the plan page, the
SAST end under a skewed `TZ`, expiry, a lapsed grant, Stripe refused even
with `--replace`, mock replaced, revoke, a team's grant and who reads it,
owner-only) and `backend/scripts/billing-grant.test.ts` (arguments).

## B2B invoices

`backend/src/billing/invoice.ts`, `backend/scripts/billing-invoice.ts`
(issue #641 Phase 5: "a Stripe Invoice from the staff tool, net 30, and a PO
number on the invoice"). The operator invoices a person's account for Pro or
a team's for Team:

```bash
pnpm dev:billing:invoice <email|team-id> <plan> --interval month|year --po "<PO number>" [--seats n] [--from YYYY-MM-DD] [--paid]
```

- **What it sends** (`provider/stripeApi.ts` `createInvoice`, API reference
  checked 2026-11-24 at the pinned `Stripe-Version`): `POST /v1/invoices`
  with `collection_method=send_invoice`, `days_until_due=30`,
  `custom_fields[0]` = `PO number` / the PO, `auto_advance=false`,
  `pending_invoice_items_behavior=exclude` and metadata
  (`billing_account_id`, `plan_code`, `seats`, `interval`, the period, our
  key `wm_invoice_key`); its lines as `POST /v1/invoiceitems` (`invoice`,
  `amount`, `description`, `period`): the plan at its included seats and,
  on Team past them, the extra seats, each at the plan table's price for
  the interval (`checkoutPrices`, the same as checkout); then
  `/finalize`, `/send` (Stripe emails it), and metadata `wm_sent=true`. The
  customer is the account's (328), made as checkout makes it when it has
  none, and stored first-writer-wins.
- **Once only.** The key is the account, plan, seats, interval, start day
  and PO number. Every POST carries an idempotency key from it, and before
  making anything the customer's invoices are searched for its
  `wm_invoice_key`: a draft is completed, an open one not yet sent is sent,
  a sent one is answered as it is (`reused`). A voided one is ignored, so a
  wrong invoice is voided in Stripe and issued again.
- **The period** runs from `--from` (a SAST day; default today) for one
  month or year, through the day before the same date (31 January + 1 month
  clamps to 28 February, so through 27 February). The answer's `until` is
  the last day the paid invoice grants.
- **Refused before Stripe is asked:** a PO number that isn't 1–64 letters,
  digits, spaces and `. / _ # : ( ) -` starting with a letter or digit
  (Stripe takes 140; it is printed on the PDF); seats outside 1–50 or below
  the plan's included ones, or extra seats on Pro; the plan that isn't the
  kind's (Pro for a person, Team for a team); and an account with a live
  Stripe subscription, which already pays by card. `manual` refuses
  (`billing_unavailable`); the mock makes `in_mock_…` from the key with no
  network.
- **When it is paid, the plan is granted** (335_invoice_grant.sql), with no
  step for the operator, however it is paid (card on Stripe's hosted page,
  or an EFT the operator marks paid in Stripe's dashboard, "paid out of
  band"; both send `invoice.paid`). For an invoice with no subscription and
  our `wm_invoice_key`, the normaliser (`provider/stripe.ts`
  `invoiceGrantOf`) adds `invoice: { ref, planCode, seats, interval,
  periodStart, periodEnd, totalMinor, issuedMinor, currency }` from its metadata
  (`stripeApi.ts` `invoiceMetadata`, written when it was issued) and its own
  total and currency; a field that doesn't parse is null. `app_billing_apply`
  then writes the grant as [§ Staff grants](#staff-grants) does: a
  `provider = 'manual'`, `active` subscription with `cancel_at_period_end`,
  the invoice's plan, seats, interval and period, and `external_ref` the
  invoice id; `billing_grant_log` gets a `grant` row with `granted_by`
  `invoice` and the reason `invoice <id> paid`, which the customer reads.
  The tick expires it at the period's end, like any grant, and the renewal
  notice skips it.
  - **Once.** A redelivery of the event is a `duplicate` (326); the same
    invoice under another event id finds its row by (`manual`, invoice id)
    and is `recorded`. `invoice.payment_failed` never touches a grant,
    before or after the payment.
  - **Refused as `conflict`** (recorded, answered 200 and logged as a
    warning, since a retry wouldn't change it; the operator reads the log
    and grants by hand if it is right): a field missing or malformed; a plan
    that isn't the account's kind's; a currency that isn't the plan's; a
    total below the amount the invoice was issued for (metadata
    `amount_minor`, `issuedMinor`), or, for an invoice without it, below the
    plan table's price for those seats and that interval (so an invoice cut
    in the dashboard grants nothing, while a price raised between issue and
    payment doesn't refuse one the customer paid as invoiced; the grant
    itself never reads an amount); a period that has ended or is longer than one interval;
    and an account with a live card subscription, an open-ended grant, or a
    grant reaching as far. A live grant ending sooner (the previous
    period's: a renewal paid early) is replaced, logged as a `revoke`, so
    the plan runs on unbroken.
  - **Not granted:** an invoice sent from Stripe's dashboard without our
    metadata (the operator grants it by hand, runbook 21), and an invoice
    on a subscription (its `customer.subscription.*` events carry the plan).
  - **Locally,** `--paid` with the mock stands in for the customer paying:
    the script posts the mock's signed `invoice.paid` (`provider/mock.ts`
    `invoicePaidEvent`) to the real webhook route and says whether the plan
    was granted.
- **Production** runs the same function as the migrate Lambda's
  `billing-invoice` owner action, **direct invoke only** (never the
  billing-admin workflow: a PO number and who is invoiced may identify a
  client, and the workflow's inputs may be public; its answer leaves the PO
  out). That function has no Stripe yet (no key, no route to
  `api.stripe.com`), so it answers `billing_unavailable` until the operator
  decides to give it one; the restricted key then also needs **Invoices:
  Write** and **Invoice items: Write** beside § Stripe's three ([deployment.md § Owner
  actions](./deployment.md#owner-actions)).

Tests: `billing/invoice.test.ts` (PO number, seats, the SAST period, lines,
key), `provider/stripeApi.test.ts` (the form fields of each request, a
retry, a voided invoice, a draft with its lines), `provider/stripe.test.ts`
(a standalone invoice's `invoice.paid` and its grant, a field that doesn't
parse, none on a subscription's invoice or a failed payment),
`provider/mock.test.ts` (the mock's paid event), `ops/ownerActions.test.ts`
(the schema, refused from the workflow), `billing/invoice.db.test.ts` (the
plan table's price, the stored customer, the refusals, the script and its
`--paid` through the webhook route, the Lambda's `billing_unavailable`) and
`billing/invoiceGrant.db.test.ts` (335: the grant, replay, either order with
a failed payment, a team's extra seats, each refusal with its positive
control, a card subscription and an open-ended grant left alone, a renewal).

## Deleting an account

Deleting a person's account or a team cascades away its `billing_account`
and `subscription` rows (323), but nothing in the database reaches the
payment provider. So the route cancels the plan there first
(`backend/src/billing/cancelOnDelete.ts`):

- **Whose plan.** `DELETE /auth/me` cancels the person's **own** account's
  (kind `user`) only. A team's plan is the team's: deleting a team admin's
  account asks the provider nothing about it, and the team keeps paying.
  A team never loses its last admin this way: the only admin of a team is
  refused (`409 account_sole_holder`) until they make someone else admin,
  so the team's plan always has an admin to manage it. `DELETE /teams/:id`
  (an admin deleting the team) cancels the team's plan the same way.
- **Open checkouts first.** Under Stripe, the customer's open Checkout
  sessions (`GET /v1/checkout/sessions?customer=…&status=open`) are
  expired first (`POST /v1/checkout/sessions/:id/expire`): one started
  before the deletion and paid after it would otherwise start a
  subscription for an account that is gone, charge the card, and reach a
  webhook that ignores the unknown account. Every session we make names
  the account's customer (`customer=`, never `customer_email`), so listing
  by customer finds them all. A session Stripe refuses to expire because it
  is no longer open (it completed or expired in between) is fine: a
  completed one's subscription is in the subscription list read next, and
  cancelled. A checkout *started* in the moment between the cancel and
  the delete (a second tab) and paid after the delete commits still makes a
  subscription for an account that is gone; the webhook catches that one
  (next item).
- **A subscription that arrives after the account is gone** (352) is
  cancelled and refunded by the webhook ([§ The route](#the-route), "An
  orphan"). Under Stripe (`provider/stripeApi.ts` `orphanCancelAndRefund`):
  `GET /v1/subscriptions/:id` for its status, `DELETE
  /v1/subscriptions/:id` (now, no final invoice, no proration) unless it has
  ended already, `GET /v1/invoices?subscription=…&status=paid`, each paid
  invoice's `GET /v1/invoice_payments?invoice=…&status=paid` (API
  2025-03-31.basil moved the payment off the invoice), and `POST
  /v1/refunds` for the whole of each payment (by its `payment_intent`, or
  `charge`), `reason=requested_by_customer`, metadata
  `wm_reason=account_deleted` and the billing account's random id, under
  the `Idempotency-Key` `wm-orphan-refund-<payment>`. A payment refunded
  already (`charge_already_refunded`, after the key's 24 hours) or charged
  back (`charge_disputed`, `refund_disputed_payment`) is skipped, and a
  trial (nothing paid) is only cancelled. So the session's and the
  subscription's events, and every redelivery, refund once. Any other
  failure answers `503` and Stripe retries (for up to 3 days); past that
  the row stays `orphan_pending` for the operator to finish in the
  dashboard. The mock has nothing to cancel or refund and answers at once,
  with no network. Endpoints checked against Stripe's API reference on
  2026-11-24 (cancel a subscription, list invoices, list invoice payments,
  create a refund, error codes). This refund is not the Terms' refund
  question (counsel's item 13 below): the person never had the plan.
- **What is cancelled.** Every live (`trialing`, `active`, `past_due`)
  subscription a provider holds (not a `manual` grant or the reverse trial,
  which nothing charges for), and, under Stripe, every other open
  subscription of the account's customer (`GET /v1/subscriptions?customer=`;
  canceled and `incomplete_expired` are over), so one whose webhook hasn't
  landed is caught too. Each is cancelled **now** (`DELETE
  /v1/subscriptions/:id` with `invoice_now=false`, `prorate=false`): no
  final invoice and **no automatic refund** for the rest of the period
  paid (the provider interface has no refund, and billing.md decides none
  elsewhere). A refund the Terms owe (the proposed 8.7's 7 days after a
  first payment, 8.6's unused months of a person's yearly plan) is made by
  hand in Stripe's dashboard, as every refund is today; whether deleting
  the account should itself trigger 8.6's refund is a question for counsel
  (billing-terms-draft.md § 6 item 13). A subscription Stripe no longer has (`resource_missing`) counts
  as cancelled. The mock has nothing outside the database to cancel.
- **When it fails.** A provider error, no provider that can cancel
  (`manual`, none configured, no Stripe key), or a live subscription
  another provider holds (a mock one after switching to Stripe) refuses the
  deletion with `503 account_plan_not_cancelled` (a team: `503
  team_plan_not_cancelled`, whose message the team page shows as it is:
  the plan couldn't be ended at the payment provider, so nothing was
  deleted; try again in a few minutes, and the plan may already have
  ended), and nothing is deleted. Logged as
  `account_delete_plan_not_cancelled` with the account's random id.
- **Order.** Self-service checks what the person alone holds first (no
  cancel for a deletion that would be refused anyway), cancels outside the
  deleting transaction (no row locks held over Stripe's round trips), then
  reads the live subscriptions again inside the deleting transaction: one
  that appeared in between (a checkout that completed) refuses the deletion
  (`503 account_plan_not_cancelled`) rather than orphan it. Deleting a team
  does the same: the admin check, then the cancel outside the transaction
  (a non-admin never triggers one), then the same re-check inside the
  deleting transaction (`503 team_plan_not_cancelled`).
- **A refused deletion may already have ended the plan.** A refusal after
  the cancel (a checkout completed in between, or a co-owner left at the
  same moment) leaves the plan cancelled: Stripe's
  `customer.subscription.deleted` ends it here too, and the person (or the
  team) is on Free. Trying again is safe: a second attempt cancels only
  what is still live, and goes through once nothing is.
- **No usable provider is an erasure blocker.** While the account has a
  live provider subscription and no provider that can cancel it is
  configured (`BILLING_PROVIDER=manual`, an unknown value, Stripe with no
  key, or the mock while the subscription is Stripe's), self-service
  deletion is refused every time. That blocks a POPIA s24 erasure request,
  so it can't be left standing: the operator cancels the subscription in
  Stripe's dashboard and deletes the account by the runbook
  ([deployment.md § Runbooks](./deployment.md#runbooks), item 7), or
  restores the provider's configuration so the person can retry.
- **The customer is kept.** The Stripe customer (`cus_…`) and its invoices
  stay at Stripe as the record of the sale, which tax law requires keeping
  (5 years under the Tax Administration Act s29 once registered; the US
  period otherwise). Our only link to it, `external_customer_ref`, goes
  with the account, and the customer we create carries only the billing
  account's random id. Deleting the customer instead (Stripe keeps its
  own records either way) waits for counsel
  ([legal/billing-terms-draft.md](./legal/billing-terms-draft.md) § 6
  item 9). Stripe's `customer.subscription.deleted` for a deleted account
  answers `unknown_account` (logged, never retried), and so does the
  delete of an orphan we cancelled.
- **The operator's path** (`DELETE FROM app_user` as the schema owner)
  can't reach Stripe, so its runbook cancels the subscription in Stripe's
  dashboard first ([deployment.md § Runbooks](./deployment.md#runbooks),
  item 7).

Tests: `billing/cancelOnDelete.test.ts` (fake providers: cancel asked,
failure refuses, nothing asked with nothing to cancel, another provider's
subscription refused), `provider.test.ts` and `provider/stripeApi.test.ts`
(the checkout session list and expiry, the subscription list and cancel
calls, in that order), `auth/delete-me.db.test.ts` (a mock plan deleted
with the account, a failing provider refuses with nothing deleted, a
checkout landing during the cancel refuses with nothing deleted, a team
admin's deletion leaves the team's plan) and `teams/teams.db.test.ts` (the
team's own deletion, the same race, and no cancel asked for by a
non-admin); `e2e/tests/account-delete.spec.ts` (the dialog's words for
`account_plan_not_cancelled`, still signed in). The orphan:
`provider/stripeApi.test.ts` (faked HTTP: the calls in order, the refund's
key and metadata, an ended or missing subscription, already refunded,
failures), `provider.test.ts` (the mock makes no call), `webhook.test.ts`
(claim, cancel, done; a redelivery; the `503`) and `orphan.db.test.ts`.

## Later phases

Pointers to [issue #641](https://github.com/jaredhoward-dev/project-water-management/issues/641);
none of this is built except where a bullet says so:

- **Enforcement** ("Enforcement design"): each limit checked in the
  transaction of the action, under an advisory lock per account, answering
  `402 plan_limit` with `{ limit, used, plan }`; soft warnings at 80%;
  downgrade and lapse without data loss. (Staff grants are built: [§ Staff grants](#staff-grants);
  so is the Team seat refusal, off until `BILLING_ENFORCED`: [§ Team seats](#team-seats);
  and Free's one live catchment, the same way, whose answer also carries
  `key: 'live_catchments'`: [§ Live catchments (Free)](#live-catchments-free).)
- **Billing provider** ("Billing provider"): dunning, refunds and invoices.
  The provider seam, the webhook, checkout and the portal are built
  ([§ Webhooks and providers](#webhooks-and-providers),
  [§ Checkout and portal](#checkout-and-portal)), and so is Phase 5's
  per-seat sync ([§ Changing a Team's seats](#changing-a-teams-seats)).
- **Legal and tax prerequisites**: the Terms' fees section, CPA and ECTA
  positions, VAT; all before the first charge.
- **Phase 4: the pricing page** is built: `/welcome/pricing` and
  `/welcome/pricing/af`, prerendered (docs/ui.md § Pricing page). A static
  page can't read `plan`, so its figures are
  `packages/engine/src/plans.ts` (`PLAN_FIGURES`), which
  `backend/src/billing/planFigures.db.test.ts` pins to the table (prices,
  limits and `trial_days`): a migration that moves a price, limit or
  trial length updates that file in the same change. Pro's reverse-trial
  line shows only in a build with `PUBLIC_REVERSE_TRIAL=true`
  ([§ The pricing page and the trial](#the-pricing-page-and-the-trial)). Still open in Phase 4: the checkout disclosures and consent tick,
  Terms §8, the privacy notice (Stripe), the `LEGAL_VERSION` bump and
  Gate D. The legal text is drafted for counsel, not live:
  [legal/billing-terms-draft.md](./legal/billing-terms-draft.md).
