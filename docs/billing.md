# Billing

Paid plans for IC-WBT ([issue #641](https://github.com/jaredhoward-dev/project-water-management/issues/641)).
This page covers **Phase 1, shadow mode**: every plan, limit and count exists
and is shown, and **nothing is refused**. There is no payment provider yet,
no checkout and no `402`. The issue holds the full design (tiers, enforcement,
provider, legal and tax prerequisites); the later phases are listed at the end
as pointers to it.

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
| `subscription` | An account's plan, status, seats and period; at most one live per account. Empty in Phase 1 |
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

## API

[api.md § Billing](./api.md#billing): `GET /billing/plans` (public),
`GET /account/plan` (signed in), `GET /teams/:id/plan` (team admins; `404`
to anyone else). No farmer route, share link, verify page or email shows plan
data.

## Webhooks and providers

Phase 3 groundwork (issue #641 "Billing provider"): the provider seam and the
webhook route. No Stripe account is opened, no Stripe API is called and no
`stripe` package is installed; checkout and the portal come later.

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
(ISO), which the SQL ignores for now; it is kept for ordering later.

| Stripe type | Normalised type | Effect in 326 |
| --- | --- | --- |
| `customer.subscription.created`, `.updated` | `subscription.updated` | the account's subscription upserted by (provider, `externalRef`) |
| `customer.subscription.deleted` | `subscription.deleted` | status `canceled` |
| `checkout.session.completed` | `checkout.completed` | recorded only |
| `invoice.paid` | `invoice.paid` | recorded only |
| `invoice.payment_failed` | `invoice.payment_failed` | recorded only (Stripe moves the subscription to `past_due` and sends `customer.subscription.updated`) |

The subscription payload is `{ accountId, planCode, status, seats,
periodStart, periodEnd, trialEnd, cancelAtPeriodEnd, externalRef }`, with
times as ISO 8601 in UTC (`…Z`). The period is read from the first
subscription item (API `2025-03-31.basil` moved it there), else from the
subscription itself (older versions). An invoice's subscription is read from
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
| `applied`, `recorded`, `duplicate` | `200 { received: true, result }` | info |
| `conflict`, `unknown_account` | `200` (a retry wouldn't change them) | warn, for the operator to read |
| `invalid` | `400` (326 doesn't record it, so a corrected retry under the same id still applies) | warn |

A database error is the app's generic `500`, which Stripe retries. Each answer
logs one line (`billing_webhook` or `billing_webhook_rejected`) with the
provider, type, event id and result or reason. It never logs the payload, the
account or the secret.

### Locally

`pnpm dev:billing:replay <fixture> [--account <id>] [--new-id]` signs one of
the synthetic events in `backend/fixtures/billing/` with the dev key and posts
it to the running API's `/billing/webhook/mock` ([run-locally.md § Billing
webhooks](./run-locally.md#billing-webhooks)). Every id in the fixtures is
invented, and their account is a placeholder UUID that `--account` replaces.
The fixtures are `checkout-completed`, `subscription-created` (trialing),
`subscription-updated` (active), `subscription-past-due`,
`subscription-deleted`, `invoice-paid` and `invoice-payment-failed`.

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

## Later phases

Pointers to [issue #641](https://github.com/jaredhoward-dev/project-water-management/issues/641);
none of this is built:

- **Enforcement** ("Enforcement design"): each limit checked in the
  transaction of the action, under an advisory lock per account, answering
  `402 plan_limit` with `{ limit, used, plan }`; soft warnings at 80%;
  downgrade and lapse without data loss; staff plan grants.
- **Billing provider** ("Billing provider"): Stripe Checkout and the Customer
  Portal, dunning, refunds and invoices. The provider seam and the webhook are
  built ([§ Webhooks and providers](#webhooks-and-providers)).
- **Legal and tax prerequisites**: the Terms' fees section, CPA and ECTA
  positions, VAT; all before the first charge.
