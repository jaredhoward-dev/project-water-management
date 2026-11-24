# Billing

Paid plans for IC-WBT ([issue #641](https://github.com/jaredhoward-dev/project-water-management/issues/641)).
This page covers **Phase 1, shadow mode**: every plan, limit and count exists
and is shown, and **nothing is refused** (no `402`). Phase 3's provider
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
`enforced`, so the UI can word the usage bars ("what you would hit") and
nothing in the code refuses on it yet. Set it in
`backend/.env.development.local` to see the enforced wording locally
([run-locally.md](./run-locally.md#one-time-setup)).

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
to `water_app`, [data-model.md](./data-model.md)) on this checkout's
database (`MIGRATION_DATABASE_URL`); in production the operator runs it with
the schema owner's connection, from inside the VPC ([deployment.md §
Runbooks](./deployment.md#runbooks) 22: the report, or the account rows in
plain SQL; there is no Lambda route yet). The maths is `backend/src/billing/metrics.ts`
(unit tests beside it), the script `backend/scripts/billing-report.ts`.

**What it prints.** Counts and aggregates; account or person ids only where a
signal needs a follow-up (the heaviest Free accounts, canonical clusters);
email domains only for a domain cluster. **No address** unless
`--show-emails` is given. That flag is for the operator's own terminal: its
output never goes into an issue, a PR, a chat or an agent's transcript.

| Metric | How it is worked out | Threshold (the issue's) |
| --- | --- | --- |
| Activation | Verified sign-ups of the month (SAST) with a model run within 7 days of signing up. Sign-ups under 7 days old are left out and counted as pending | < 30% → fix onboarding first |
| Active Free accounts near / at each limit | Active = a run, a server report or assistant use this month on the account's projects. Near ≥ 80% of the limit, at ≥ 100%, for reports (5), the assistant's dollars ($1) and catchments (Free has no limit, so none) | > 15% at reports → 10 a month; < 3% at the monthly assistant cap → room to raise |
| Assistant spend per account | p50 and p90 (nearest rank) per plan over the accounts that spent this month, with the total and any unpriced turns (then a floor) | Paid: > 20% at $15 → top-up packs sooner |
| Free spend by accounts under 7 days old | Its share of the month's Free assistant spend. `assistant_usage` is monthly, so an account counts as new when its latest spend of the month came under 7 days after it started: **an upper bound** | > 50% → escalation (b) |
| Heaviest Free accounts | The five with the most assistant spend, by account id | |
| Sign-ups per day | Per SAST day of the month; the three busiest printed | |
| Domain clusters | Email domains with 5 or more sign-ups in some 7 days of the month; common providers are marked, not hidden | Escalation (a) |
| Canonical clusters | Canonical addresses (lower-cased, `+tag` dropped, Gmail's dots dropped, googlemail.com as gmail.com) with more than one account, ever, where one signed up this month; the user ids | Escalation (a) |

The plan is each account's plan **today**; in Phase 1 that is Free for
everyone. Runs, reports and sign-ups use the SAST month; the assistant's
spend keeps `assistant_usage`'s UTC month, as `app_account_plan` does.

**Not yet measurable**, printed as such so a gap is never read as a zero
(the app doesn't record what each needs): upgrade at the limit (no checkout,
trial or limit-message events), churn after the limit (no record of hitting
one), reverse trial to paid (no trials), the share at the assistant's daily
cap and the Free pool's burn by day (`assistant_usage` is monthly; no daily
cap or pool yet), the share at the live-catchment limit (nothing is marked
live), paid seats reaching $15 (spend isn't kept per paid seat), disposable
rejections (no blocklist yet), sign-up throttle hits per address
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
| `invoice.paid` | `invoice.paid` | recorded only |
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

A database error is the app's generic `500`, which Stripe retries. Each answer
logs one line (`billing_webhook` or `billing_webhook_rejected`) with the
provider, type, event id and result or reason. It never logs the payload, the
account or the secret.

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
   billing changes the one there is, so Stripe never holds two). The body's
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
- **Changing seats later** is the portal's (Stripe's quantity on the extra
  item), not built here: the portal can't add the second item to a
  subscription that has none, so until then the operator changes a Team's
  seats in Stripe's dashboard (the webhook syncs them). A follow-up item in
  [followups.md](./followups.md) (§ Billing) tracks it.

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
  trials using > 60% of the Free pool). The reverse trial is Phase 2 and not
  built here.
- **Team: on request.** The "Recommended tiers" table's Trial row says
  "30-day Team trial on request": an operator decision per team, which is a
  staff plan grant (Phase 2, the staff grant), not a checkout option a team
  admin picks.

So the checkout's subscription starts `active` and charges at once; the
normaliser still reads `trialing` and `trial_end`, for a trial the operator
sets in Stripe's dashboard by hand. Revisit when escalation (c) triggers.

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
- `e2e/tests/billing-checkout.spec.ts`: the plan page's buttons, Team's seat
  field, and the mock checkout and portal in a browser.

## Staff grants

`backend/migrations/330_staff_grant.sql`, `backend/scripts/billing-grant.ts`
(issue #641, "Staff overrides"). The operator's tool for manual plans: the
first client's deal, founding users (Q4's grandfathering), and **v1 B2B
invoices**. A business that pays by invoice gets a manual Stripe invoice (sent
from the Stripe dashboard, outside the app), and once it is paid the operator
grants the plan until the end of the invoiced period. It works with
`BILLING_PROVIDER` unset.

```bash
pnpm dev:billing:grant <email|team-id> <plan> [--until YYYY-MM-DD] --reason "…" [--replace] [--by <name>]
pnpm dev:billing:grant <email|team-id> --revoke --reason "…" [--by <name>]
pnpm dev:billing:grant <email|team-id> --list
```

It runs as the schema owner on this checkout's database (like
`dev:billing:report`); in production the operator calls the same functions as
the schema owner, step by step in [deployment.md § Runbooks](./deployment.md#runbooks)
21 (finding the account, the exact `SELECT`, revoking, checking the log). An address is used only to find the person's account and
is printed only as the operator typed it. `--by` defaults to the operator's
login.

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

## Later phases

Pointers to [issue #641](https://github.com/jaredhoward-dev/project-water-management/issues/641);
none of this is built:

- **Enforcement** ("Enforcement design"): each limit checked in the
  transaction of the action, under an advisory lock per account, answering
  `402 plan_limit` with `{ limit, used, plan }`; soft warnings at 80%;
  downgrade and lapse without data loss. (Staff grants are built: [§ Staff grants](#staff-grants).)
- **Billing provider** ("Billing provider"): dunning, refunds and invoices.
  The provider seam, the webhook, checkout and the portal are built
  ([§ Webhooks and providers](#webhooks-and-providers),
  [§ Checkout and portal](#checkout-and-portal)).
- **Legal and tax prerequisites**: the Terms' fees section, CPA and ECTA
  positions, VAT; all before the first charge.
