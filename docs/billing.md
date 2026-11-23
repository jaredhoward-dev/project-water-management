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
the schema owner's connection. The maths is `backend/src/billing/metrics.ts`
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
to anyone else). No farmer route, share link, verify page or email shows plan
data.

## Later phases

Pointers to [issue #641](https://github.com/jaredhoward-dev/project-water-management/issues/641);
none of this is built:

- **Enforcement** ("Enforcement design"): each limit checked in the
  transaction of the action, under an advisory lock per account, answering
  `402 plan_limit` with `{ limit, used, plan }`; soft warnings at 80%;
  downgrade and lapse without data loss; staff plan grants.
- **Billing provider** ("Billing provider"): Stripe Checkout and the Customer
  Portal behind `BILLING_PROVIDER` (`mock` by default, local-first), the
  webhook as the only writer of `subscription`, dunning, refunds and invoices.
- **Legal and tax prerequisites**: the Terms' fees section, CPA and ECTA
  positions, VAT; all before the first charge.
