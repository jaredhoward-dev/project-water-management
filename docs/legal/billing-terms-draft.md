# Billing terms: proposed text for counsel

**DRAFT FOR COUNSEL. NOT LEGAL ADVICE. NOT LIVE.** Nothing in this file is
shown to anyone or has been accepted by the operator. The Terms of use
(`/terms`) and the privacy notice (`/privacy`) are unchanged, and so is
`LEGAL_VERSION`. This is #641 Phase 4's legal work, drafted from what the code
does on 2026-11-24 ([billing.md](../billing.md)) and #641's decisions, so that
a South African attorney (and, for the seller's side, a US one) has the
proposed words, the current words and the reasons side by side. Pre-counsel
research, written by an engineer, not a lawyer; every "For counsel" line is a
question, not an answer. Tracked in [legal-status.md](../legal-status.md)
Gate D.

How to read it: each clause has the **current text** (quoted from the live
page), the **proposed text**, what it **rests on** (the code, billing.md, or
#641's decision), and the question **for counsel**. Section 4 is the checkout
disclosures and consent tick the app would need; section 5 what a
`LEGAL_VERSION` bump would involve; section 6 every counsel question in one
list.

## 1. The facts the draft rests on

- **Seller.** The operator named in Terms §1, a US sole proprietor based in
  Virginia, sells on Stripe (a US Stripe account; #641 Decisions,
  2026-10-28, Q0). No South African entity; no business address published
  yet (legal-status.md Gate C).
- **Plans and prices** (`323_billing.sql`, pinned to
  `packages/engine/src/plans.ts` by `billing/planFigures.db.test.ts`): Free
  R0; Pro R899 a month or R8,990 a year; Team R2,499 a month or R24,990 a
  year with 3 editor seats, each further editor R499 a month or R4,990 a
  year; an issued evidence pack R1,499 on Free, R999 on Pro, 3 a month
  included on Team then R999. Prices in rand; **no VAT is charged** (not
  registered; the pricing page says so).
- **Free** limits only what costs money or is day-to-day operations (one
  live catchment, 5 server reports a month, about $1 of assistant a month)
  and never modelling. **Free is for non-commercial use** (#641 Decisions,
  2026-10-28; the pricing page already says so).
- **Farmers, viewers, contributors and assessors** hold no seat and are never
  charged (billing.md § Team seats; #641 "Rejected options").
- **Built but off.** Limits refuse only with `BILLING_ENFORCED=true`
  (billing.md § `BILLING_ENFORCED`); the reverse trial needs
  `REVERSE_TRIAL=true` too; production's provider is `manual` until Stripe
  is set up (deployment.md § Turning on Stripe). So the clauses below
  describe behaviour that exists in code and is not yet switched on.
- **The card never reaches us.** Stripe Checkout and the Customer Portal are
  hosted by Stripe (billing.md § Checkout and portal).

## 2. Terms §8, Fees

### Current text (Terms §8, `frontend/src/routes/terms/+page.svelte`)

> The service is currently provided without charge. If we introduce fees, we
> will tell you in advance, and nothing will be charged without your
> agreement to the price and terms at that time.

### Proposed text

The proposed §8 replaces that paragraph with the sub-clauses below. Square
brackets mark a choice for the operator or counsel.

**8.1 Plans.**

> The service has a free plan (Free) and paid plans (Pro, for one person, and
> Team, for a team). The pricing page lists what each plan includes, its
> limits and its price; the version shown when you buy is the one that
> applies to you until it changes under 8.8. Farmers, viewers, contributors
> and assessors are never charged, whatever plan the project they use is on.

- *Rests on:* `plan` (323), `/welcome/pricing` (`Pricing.svelte`), billing.md
  § Who the plan belongs to and § Team seats (no seat for those roles).
- *For counsel:* is incorporating the pricing page by reference ("the version
  shown when you buy") enough under ECTA s43(1)(i)–(j) and CPA s49, or must
  the limits be in the Terms themselves? A plan's limits change by migration;
  the draft treats that as a price/plan change under 8.8.

**8.2 Free is for non-commercial use.**

> Free is for non-commercial use: study, research, and a catchment of your
> own. Work done for a paying client, or as part of a business, needs Pro or
> Team. One free account per person. We may suspend an account that breaks
> this clause, or that is one of several accounts made to get more than one
> free allowance or trial, after telling you why (section 11).

- *Rests on:* #641 Decisions 2026-10-28 ("the archive loophole is closed:
  Free is for non-commercial use … accepted at sign-up and when a project is
  created") and 2026-10-29 items 1 and 6 (one free allowance per verified
  person; Terms: one free account per person, non-commercial use, the right
  to suspend). The pricing page's line; the abuse report's canonical-email
  clusters (billing.md § Metrics and the abuse report).
- *Not built:* the acceptance "when a project is created" (no prompt in the
  new-project flow) and a suspend action (billing.md § Metrics: "no suspend
  action yet"). Terms §4 already says "One person per account".
- *For counsel:* is "non-commercial" certain enough to enforce, and to
  suspend on, without a definition? Is a water user association (a
  statutory body, not a business) commercial when it uses Free? Is a
  suspension for a Free-tier breach a "reasonable" term under CPA s48 given
  the account holds the person's modelling work (which stays downloadable)?

**8.3 Trial.**

> When you confirm your email address for the first time, you may get Pro free
> for 14 days. No card is needed and nothing is charged; at the end you are on
> Free, and nothing you made is deleted. One trial per person, judged by email
> address: we keep a one-way fingerprint of the address (privacy notice §3) so
> that a new account for the same address gets no second trial. During the
> trial the assistant is limited to [US $2 in all and US $1 a day].
> [We may stop offering the trial.]

- *Rests on:* billing.md § The reverse trial (342; `reverse_trial_claim`;
  `TRIAL_CAPS`), § Trials (decided 2026-11-23: checkout sells no trial), §
  Plan emails (the 3-day email). Off until `REVERSE_TRIAL` and
  `BILLING_ENFORCED` are on.
- *For counsel:* a free trial with no card and no automatic conversion is not
  a negative option; confirm no consent beyond the Terms is needed. Is the
  once-per-canonical-email rule (Gmail dots and `+tag` collapsed) fair
  disclosure as worded?

**8.4 Prices, currency and taxes.**

> Prices are in South African rand. [No VAT is charged: we are not registered
> for VAT in South Africa.] The price shown at checkout is the full price you
> pay. Your card issuer may charge you a foreign-transaction fee, because we
> are based in the United States; that fee is between you and your bank. If we
> must start charging VAT, the price shown at checkout will say so, and a
> change to what you pay is a price change under 8.8.

- *Rests on:* #641 "Tax and consumer law" (no SA VAT registration in year 1;
  invoices must not show VAT before registration; CPA price display), the
  pricing page's "Prices are in rand. No VAT is charged.", billing.md §
  Stripe (inline `price_data` in the plan's currency).
- *For counsel and a tax adviser:* the foreign e-services threshold (R1m or
  R2.3m) and its tracking; whether the foreign-transaction-fee sentence is
  needed or wise (Stripe charges in ZAR, so an SA card should see a rand
  charge, but the merchant is foreign); if VAT registration comes, whether
  consumer prices become VAT-inclusive (#641: "the same figures become
  VAT-inclusive for individuals") without a price-change notice.

**8.5 Paying, and renewal.**

> You pay by card through Stripe, our payment provider; we never see your card
> number. A paid plan is billed monthly or yearly, as you choose at checkout,
> in advance, from the day you buy. **It renews automatically at the end of
> each month or year, at the price then in force, and your card is charged
> then, until you cancel.** If you are a person (not a company, association or
> other organisation) on a yearly plan, we will email you between 40 and 80
> business days before it renews, with the price for the next year and how to
> cancel.

- *Rests on:* billing.md § Checkout and portal (Stripe Checkout,
  subscription mode, starts `active` and charges at once), § Billing interval
  and editor count, § Renewal notice (60 business days, a floor of 45;
  person's accounts on a yearly period only; `renewal.ts`, 329).
- *For counsel:* **CPA s14(2)(d).** On expiry, s14 continues an individual's
  fixed-term agreement month to month unless the consumer directs otherwise;
  this clause renews the year. Does a yearly renewal need the person's
  express choice at renewal (an opt-in in the notice), or is the renewal
  notice plus this clause enough? Alternatives: (a) renew yearly only for
  those who tick "renew yearly" in the notice, else move them to monthly at
  the monthly price; (b) treat every yearly plan as renewing month to month
  after the first year. (a) needs a link in the email and a portal or app
  step; (b) needs the provider to switch interval at the period's end.
  Also: US auto-renewal law, since the seller is in Virginia (ROSCA's clear
  disclosure and express consent before charging, and any Virginia automatic
  renewal statute): does this clause plus the checkout tick (§ 4) satisfy
  them for a non-US buyer?

**8.6 Cancelling.**

> You can cancel at any time on the Plan and usage page (it takes you to
> Stripe's billing page). Cancelling stops the next renewal: you keep the plan
> until the end of the month or year you paid for, nothing more is charged,
> and you are then on Free (8.11).
>
> If you are a person (not an organisation) on a yearly plan, you may also end
> it before the year is out, on 20 business days' notice (Consumer Protection
> Act, section 14). We then refund the months you paid for and won't use,
> [less one month's price] [with no deduction].

- *Rests on:* billing.md § Checkout and portal (the portal's cancel at the
  period's end, `cancel_at_period_end`), § Renewal notice (the email already
  states the Act's right to end a yearly plan on 20 business days' notice and
  names no penalty), #641 "Billing provider" → Refunds ("refund the unused
  months less a reasonable penalty (recommended: none, or one month)").
- *Not built:* the early end of a yearly plan is a refund the operator makes
  by hand in Stripe's dashboard (no app path); the portal cancels only at
  the period's end.
- *For counsel:* **the early-cancellation penalty** (none, or one month).
  CPA s14(2)(b)(ii) gives the early end, and s14(3)(b) with Regulation 5
  allows a "reasonable cancellation penalty"; is one month reasonable on R8,990 a year, and does it need to be
  stated in the notice as well? Is a refund made by hand within a stated time
  enough, or must the app offer the early end itself?

**8.7 Refunds.**

> If you ask within 7 days of your first payment for a plan, we refund it in
> full, no questions asked, and the plan ends. Otherwise payments are not
> refunded, except as 8.6 says for a person's yearly plan, under 11 when we
> stop the service, or where the law gives you a right to one. Ask by email
> (section 19).

- *Rests on:* #641 Decisions ("the operator handles support and refunds,
  with a 7-day no-questions refund on a first payment"), "Tax and consumer
  law" (ECTA s44's 7-day cooling-off; s42(2)'s exclusion for services begun
  with consent within the 7 days; "offer a full refund within 7 days of a
  first payment anyway"). Refunds are made in Stripe's dashboard; the
  webhook syncs the cancellation (#641 Operator steps E3).
- *For counsel:* with the 7-day refund offered, is ECTA s44 met whether or not
  s42(2)'s exclusion applies, and should checkout still record the consent of
  § 4 (item 7) to keep the exclusion? Does "first payment for a plan" cover a
  switch from Pro to Team (a new first payment for Team)? Is "no refund
  otherwise" consistent with CPA s54 (quality of services) and s56?

**8.8 Price and plan changes.**

> We may change a plan's price, what it includes, or its limits. We will email
> you at least 30 days before a change that costs you more or gives you less
> takes effect for you; it applies from your next renewal after that, and you
> can cancel before then (8.6). A change in your favour may apply at once.

- *Rests on:* #641 "Legal and tax prerequisites" 1 ("price changes on 30 days'
  notice"); billing.md § Renewal notice open point (if Stripe's price ever
  differs from the plan table's, the renewal email must take the provider's).
- *Not built:* no bulk notice tool (legal-status.md "Material-change emails":
  send by hand); prices are inline at checkout, so an existing subscription
  keeps its price until changed in Stripe.
- *For counsel:* is 30 days enough against Terms §16's 15 days for other
  material changes, and should §16 be cross-referenced? For an individual's
  yearly plan, does a price rise at renewal also need the s14(2)(c) notice's
  "material change" wording (the renewal email states next year's price)?

**8.9 Team seats.**

> A Team plan includes [3] editor seats; each further editor is charged at the
> price on the pricing page. An editor seat is held by each person who can
> edit the team's projects (team members and admins, and direct editors and
> owners of its projects), counted once. A team admin can change the number of
> seats on the team's Plan page. Adding a seat during a period is charged, for
> the rest of that period, on the next invoice; removing one credits the
> unused part on the next invoice. While the team is at its seats, adding
> another editor is refused until a seat is added.

- *Rests on:* billing.md § Team seats (334, `app_team_seats_in_use`), § Team
  seats at checkout, § Changing a Team's seats (`SEAT_PRORATION` =
  `create_prorations`).
- *For the operator:* the proration choice is still to confirm (billing.md:
  "a decision for the operator to confirm"); this clause follows the code.
- *For counsel:* a team is usually an organisation, outside CPA s14; anything
  else for B2B seat billing?

**8.10 Evidence packs.**

> Issuing a licensing evidence pack costs the price on the pricing page for
> your plan, charged when you issue it, unless your plan includes it. Drafts,
> sign-offs, withdrawals and the public verify page are free.

- *Rests on:* `plan.features` pack prices (323, `PLAN_FIGURES`), billing.md
  § Shadow mode (issued packs counted).
- *Not built:* no checkout sells a single pack yet; leave this clause out of
  the live text until it is.

**8.11 Failed payments, downgrades and ending a plan.**

> If a payment fails, Stripe will try again and email you, and you keep your
> plan for [14 days]. When a plan ends (you cancel, a payment can't be taken,
> or a trial ends), you are on Free. Nothing you made is deleted, and you can
> always download your projects and your data on any plan. If you then have
> more live catchments than Free allows, their data feeds, automatic runs and
> alerts carry on for 14 days and then pause on all but one (you choose
> which), until you upgrade or switch the others off; we email the owners
> when the 14 days start and when the pause lands.

- *Rests on:* billing.md § Pausing after a downgrade (341: the 14-day grace,
  the marker, nothing deleted), § Choosing the catchment to keep (345), §
  Plan emails (346), #641 "Billing provider" → Dunning (`past_due`, full
  access for 14 days). Stripe's Smart Retries and failed-payment emails are
  dashboard settings (#641 Operator steps B3).
- *Not built:* `past_due` keeps the plan (it counts as live) for as long as
  Stripe keeps it `past_due`; the "14 days" of dunning is Stripe's retry
  schedule, set in the dashboard, not app code. Confirm the number there
  before the clause states one.

**8.12 Business customers and invoices.**

> An organisation may instead pay for a year or a month by invoice, against
> its purchase order: we send a Stripe invoice in rand, payable within 30
> days, by card on Stripe's page [or by bank transfer]. The plan starts when
> the invoice is paid and lasts for the period it covers; it does not renew
> by itself. [These terms apply to that plan, with any agreement we sign with
> the organisation taking precedence where they differ.]

- *Rests on:* billing.md § B2B invoices (`days_until_due=30`, the PO number
  as a custom field, `invoice.paid` grants the plan for the invoiced period,
  335), § Staff grants (330), #641 Decisions ("B2B EFT: check once"; until a
  ZAR receiving account is confirmed, card or SWIFT).
- *For counsel:* the precedence sentence against the client service
  agreement (Gate D); whether a purchase order's own terms (often printed on
  POs) can override these, and how to exclude that.

### Consequential edits elsewhere in the Terms

| Section | Current | Proposed change | Rests on / for counsel |
| --- | --- | --- | --- |
| §1 | "By creating an account … you accept these terms" | Add: "If you buy a paid plan, section 8 also applies to that purchase, as accepted at checkout." | Links the checkout tick (§ 4) to the Terms. |
| §11 Suspension and ending | "We may also stop offering the service; if we do, we will give at least 30 days' notice …" | Add: "If we stop the service, or end your account for a reason other than your breach, we refund the part of any paid period you won't get." Suspension for breach: say whether a paid period is refunded. | No refund rule exists today because nothing is charged. For counsel: CPA s14 and s48 on ending a paid plan for breach. |
| §13 Limitation of liability | "the greater of (a) the fees you paid us in the twelve months … or (b) one hundred US dollars (US $100)" | No wording change proposed; with fees, (a) becomes real: R8,990 a year (Pro) or R24,990+ (Team). | #641 Legal 1 ("re-check the liability cap against real fees"); legal-status.md Gate D (the US $100 floor against real fees). For counsel. |
| §16 Changes | "If a change is material, we will email account holders at least 15 days before it takes effect." | Add: "Price and plan changes follow section 8.8." | Keeps 15 days for terms, 30 for prices. |
| §15 Governing law | per user | No change; CPA and ECTA rights already preserved. | For counsel: is a Stripe dispute (chargeback) a "proceeding" the 30-day informal step should cover? |
| The short version (`termsSummary.ts`) | four points | Consider a fifth: "Free is for non-commercial use. Paid plans renew automatically until you cancel; you can cancel at any time." | CPA s49(1)–(2) (draw attention to terms that limit rights or impose obligations). Changing a point bumps `LEGAL_VERSION` and goes through the translation sheet. |

## 3. The privacy notice's billing parts

Current notice: `frontend/src/routes/privacy/+page.svelte`, written from
[security.md § Personal information (POPIA)](../security.md#personal-information-popia),
which already lists the billing tables (323–346) and `reverse_trial_claim`.
The notice itself says nothing of billing. These additions bring it level
with security.md and add Stripe.

**§3 What we collect: a new item under "Information you give us".**

> **Billing, if you buy a plan:** your plan, whether it is monthly or yearly,
> the number of seats, the dates it runs and renews, and its status; the
> reference Stripe gives your customer record; a business customer's purchase
> order number; and records of the plan emails and renewal notices we sent
> you. Your name, billing address, [VAT number,] card details and invoices
> are collected and kept by Stripe, our payment provider. We never see or
> store your card number.

And under "Information collected as you use the service":

> **The free trial:** that an email address has had its trial, kept only as a
> one-way fingerprint of the address (not the address, and not linked to your
> account), so the same address gets one trial only.

- *Current text:* none (§3 lists no billing data).
- *Rests on:* security.md § Personal information rows for `billing_account`
  (with `external_customer_ref`), `subscription`, `usage_counter`,
  `renewal_notice`, `billing_notice`, `billing_grant_log`, `billing_event`,
  `reverse_trial_claim`; billing.md § B2B invoices (the PO number goes to
  Stripe as an invoice custom field, not into our database).
- *For counsel:* the trial fingerprint is pseudonymous, not anonymous
  (security.md says so); is the wording honest enough?

**§4 Why we use it: new rows in the table.**

| Use | Lawful basis (POPIA s11) |
| --- | --- |
| Selling and running a paid plan: checkout, renewal, seats, invoices, refunds, and the emails about them | Needed to perform our agreement with you (s11(1)(b)) |
| Keeping billing and tax records | A legal obligation (s11(1)(c)) [under US tax law and, once registered, South Africa's Tax Administration Act] |
| One trial and one free allowance per person: the trial fingerprint, and counting accounts that share an address | Our legitimate interest in preventing abuse of the free plan (s11(1)(f)) |

- *Rests on:* billing.md § The reverse trial, § Metrics and the abuse report.
- *For counsel:* which law's record-keeping duty applies to a US seller
  (IRS: generally at least 3 years; SA's Tax Administration Act s29: 5
  years, if registered) and whether s11(1)(c) covers a foreign law's duty.

**§5 Who can see it: the service-providers bullet.**

> *Current:* "**Our service providers**, who process information only on our
> instructions: Amazon Web Services (hosting, the database, file storage,
> sending email, and logs) and, for the assistant, its Amazon Bedrock service
> …"
>
> *Add:* "and, if you buy a plan, Stripe, Inc. (payments, subscriptions and
> invoices). Stripe also uses some of that information for its own purposes,
> such as preventing fraud and meeting its legal duties, under its own privacy
> policy [link]."

- *Rests on:* #641 "Tax and consumer law" → POPIA ("Stripe becomes an
  operator for billing data … on Stripe's DPA"). Stripe's own terms make it
  a separate controller for fraud and compliance uses; the clause says so
  rather than calling Stripe only our operator.
- *For counsel:* Stripe as operator (s20–21) for billing, and as its own
  responsible party for fraud and regulatory uses: is a split description
  right, and is Stripe's DPA the s21 written agreement? The operator
  agreement's clause 6.1 lists sub-processors for **the client's** project
  data; billing data is ours (we are its responsible party), so Stripe is not
  proposed for 6.1. Confirm.

**§6 Where it is kept: a new paragraph.**

> *Current:* "We run the service from the United States, so when we operate
> or support it, information may be accessed from there. POPIA allows this
> (s72): …"
>
> *Add, before it:* "If you buy a plan, your billing information is processed
> by Stripe in the United States and elsewhere. POPIA allows this (s72): it is
> needed to perform our agreement with you (s72(1)(c)), and Stripe is bound by
> a written agreement to protect it to a standard at least as high as POPIA's
> (s72(1)(a))."

- *Rests on:* the same gateways as the AWS paragraph (legal-status.md §
  Configuration: "Cross-border").
- *For counsel:* whether s72(1)(a) is met by Stripe's DPA and its transfer
  mechanisms, and whether s72(1)(c) fits a payment the person chose to make.

**§7 How long we keep it: a new item.**

> **Billing:** your plan's records (plan, seats, dates, status, the customer
> reference, the plan emails and renewal notices sent) until your account is
> deleted; the payment provider's messages to us about your plan, 90 days.
> Stripe keeps invoices and payment records for as long as tax and financial
> law requires [at least 5 years], also after your account is deleted, as a
> record of the sale. The trial fingerprint is kept for good, since the rule
> is one trial ever.

- *Rests on:* security.md § Personal information (`billing_account`,
  `subscription`, `usage_counter`, `renewal_notice`, `billing_notice`,
  `billing_grant_log`: until the account is deleted, by cascade;
  `billing_event`: 90 days, `app_purge_billing_events`;
  `reverse_trial_claim`: kept on deletion), #641 "Legal and tax
  prerequisites" 2 ("invoices kept 5 years (Tax Administration Act s29;
  confirm) while separated from account deletion").
- *Built (2026-11-24):* deleting an account (and deleting a team) first
  cancels the live Stripe subscription, now and with no automatic refund,
  and refuses the deletion if Stripe can't
  ([billing.md § Deleting an account](../billing.md#deleting-an-account)).
  The Stripe customer (`cus_…`) and its invoices are **kept** at Stripe as
  the tax record, unlinked from the person here (`billing_account` and its
  `external_customer_ref` cascade away), as the clause above assumes;
  security.md § Personal information says so. Deleting the customer instead
  waits for counsel (§ 6 item 9). If the notice keeps this clause, add:
  "Deleting your account cancels a paid plan at once.
- *For counsel:* "kept for good" for the trial fingerprint against POPIA s14
  (no longer than necessary); an alternative is a fixed period (for example 3
  years) after which a second trial is accepted.

**§10 Your rights.** No change: "Download my data" already includes
`billing` (account, subscriptions, counters, renewal notices, plan emails,
grants; `backend/src/auth/export.ts`). Add one sentence: "Stripe's own
records of your payments can be asked for from Stripe, or from us and we
will get them." *For counsel:* whether the access right (s23) reaches what
Stripe holds as our operator.

**§12 Changes.** Adding Stripe is a new recipient and a new transfer abroad,
so a **material change**: it goes out with the Terms in one `LEGAL_VERSION`
(section 5 below), as the assistant's did (legal-status.md change log,
2026-10-27).

## 4. Checkout: the disclosures and the consent tick

Today the Plan and usage page's **Upgrade** button
(`frontend/src/lib/components/billing/PlanUsage.svelte`, words in
`plan.ts`) calls `POST /account/plan/checkout` or `/teams/:id/plan/checkout`
(`backend/src/billing/routes.ts`, body `checkoutBody`) and goes straight to
Stripe's hosted page. Nothing is shown or recorded between the button and
Stripe. What it would need, before the first live charge:

**Disclosures before the person pays** (ECTA s43(1); counsel to check the
list against the Act's text, which this was written from):

- [ ] Who sells: the operator's full name and legal status (sole proprietor),
      physical address and a telephone number (Gate C: none published yet),
      the website and email. Today the pricing page and Terms §19 give email
      only.
- [ ] What is bought: the plan, its main limits, monthly or yearly, and for
      Team the seats (the Plan page already shows the total per interval:
      `subscriptionTotalLine`, and the seat field's price).
- [ ] The full price, in rand, with "No VAT is charged" (or the VAT, once
      registered), and that the card is charged now and at each renewal.
- [ ] That it renews automatically until cancelled, how to cancel (Plan and
      usage → Manage billing), and that cancelling keeps the plan to the
      period's end.
- [ ] The 7-day refund on a first payment, and the CPA s14 early end for a
      person's yearly plan.
- [ ] Links to the Terms (§8) and the privacy notice (Stripe as a provider).
- [ ] That the record of the purchase (invoices, receipts) is in Stripe's
      portal and emailed by Stripe (s43(1)(l): how to access and keep a full
      record).
- [ ] Security: card details are taken by Stripe, never by us.
- [ ] ECTA s43(2): a chance to review the whole order, correct it and back
      out before paying. Stripe's hosted page shows the order and has a back
      link; counsel to confirm that is enough.

**The consent tick** (required, unticked, beside the Upgrade button, so it is
seen before Stripe's page):

> ☐ I want [Pro] to start now, at [R899 a month]. It renews every [month]
> until I cancel, and I can cancel at any time on Plan and usage. I accept
> section 8 of the [Terms of use]. I can ask for a full refund within 7 days
> of this first payment.

- *Why each part:* "start now" is the ECTA s42(2) consent to a service begun
  within the cooling-off period (#641: "checkout records that consent
  explicitly"); "renews … until I cancel" is the automatic-renewal
  disclosure (CPA s49, and ROSCA's express consent for a US seller); the
  Terms link is ECTA s11/s43(1)(j) incorporation.
- *What it records* (needs a migration, not in this change): the account,
  the person, the plan, interval, seats and the price shown, the
  `LEGAL_VERSION` in force and a version of the tick's words, and when. A
  table like `checkout_consent`, written by the checkout route before it
  calls the provider, refusing (`400`) a checkout without the tick's
  version (as `/auth/register` refuses a stale `acceptTerms`), in "Download
  my data" with the rest of `billing`.
- *Stripe's side:* Checkout can also require its own Terms acceptance
  (`consent_collection[terms_of_service]=required`, with the Terms URL set
  in the dashboard; `custom_text` for a line beside the pay button).
  Belt and braces, not a substitute: the app's record is the one we hold.
  It would be one more field in `provider/stripeApi.ts`'s session call.
- *Where the words live:* the workspace is English (`plan.ts`); the tick
  would follow, with the Terms binding in English (§17).
- *Tests it would need:* `plan.test.ts` (the words for each plan and
  interval), `checkout.test.ts` and `checkout.db.test.ts` (refused without
  the tick, recorded with it), `stripeApi.test.ts` (the consent fields), and
  `e2e/tests/billing-checkout.spec.ts` (the tick before the mock page).
- *Also:* the seat change (`SeatChange.svelte`'s confirm step) is a price
  change the admin makes; it already shows the new total; counsel to say
  whether it needs its own tick. The renewal email already carries the
  s14(2)(c) content (billing.md § Renewal notice).

## 5. What a `LEGAL_VERSION` bump would involve

`LEGAL_VERSION` (`packages/engine/src/legal.ts`, now `2026-10-27`) is the
date the Terms and privacy notice took effect. Bumping it makes every
account read `termsCurrent: false` and shows the full-page re-acceptance
step before any app page (`auth-extras/TermsUpdate.svelte`; legal-status.md
"Asking again after a change"). For the billing text, in one change, on the
day it goes live and **before the first charge**:

1. **The pages.** `frontend/src/routes/terms/+page.svelte` (§8 and the
   consequential edits of § 2) and `frontend/src/routes/privacy/+page.svelte`
   (§3–§7 of § 3), from the counsel-approved text.
2. **The version.** `LEGAL_VERSION` in `packages/engine/src/legal.ts` to the
   go-live date. If the assistant's open item (legal-status.md: move the
   2026-10-27 version to the assistant's release) is still open, the two can
   share one version.
3. **What changed.** A new top entry in `TERMS_CHANGES`
   (`frontend/src/lib/components/auth-extras/termsChanges.ts`), e.g. "Paid
   plans: Free stays free for non-commercial use; Pro and Team are paid,
   renew until you cancel, and can be cancelled at any time. Payments go
   through Stripe, which receives your billing details." These lines are
   farmer-facing: `pnpm gen:i18n:sheet`, then the i18n-translator and
   i18n-checker agents and `pnpm gen:i18n:apply af`.
4. **The summary**, if a fifth point is added (`termsSummary.ts`; shown at
   sign-up, on the Terms and on the re-acceptance step), through the same
   translation flow; `TermsSummary.test.ts`.
5. **The record.** security.md § Personal information (Stripe as a
   sub-processor; the deletion step of § 3), legal-status.md's change log
   and Configuration ("Fees: none" becomes the new §8), and the operator
   agreement if counsel puts Stripe in clause 6.1.
6. **The notice before it.** Terms §16 promises an email at least 15 days
   before a material change (8.8 proposes 30 for prices). There is no bulk
   email tool (legal-status.md "Material-change emails"): send it by hand,
   or build one first.
7. **The tests.** `e2e/tests/terms-update.spec.ts` (the step with the new
   entry), `e2e/tests/legal.spec.ts` (the pages), `packages/engine/src/legal.test.ts`,
   and the backend tests that send `acceptTerms: LEGAL_VERSION` (they read
   the constant, so need no edit).
8. **Order with the switches.** Bump with or before `BILLING_ENFORCED` and
   `BILLING_PROVIDER=stripe` go on; the checkout tick (§ 4) records the new
   version, so it should refuse a checkout from an account that hasn't
   re-accepted (the API today doesn't refuse other calls from such an
   account; only the app is gated).

Existing users move to Free at launch (#641 Decisions: "nothing special").
For counsel: is moving them to a plan with limits they didn't have a
material change needing the 15-day notice even though nothing is charged?

## 6. Every question for counsel, in one list

1. CPA s14(2)(d): may an individual's yearly plan renew for a year, or must
   it continue month to month unless they choose otherwise (8.5)?
2. The early-cancellation penalty for an individual's yearly plan: none or
   one month (8.6).
3. ECTA s42(2)/s44: with a 7-day refund offered anyway, is the consent tick
   still advisable, and is "first payment" well defined (8.7)?
4. ECTA s43: the disclosure list against the Act, s43(2)'s review step on
   Stripe's hosted page, and whether email-only contact can stand until
   Gate C (§ 4).
5. "Non-commercial use" and one free account per person: certain enough to
   suspend on? Is a WUA commercial (8.2)?
6. The liability cap (§13) against real fees; refunds on our ending the
   service or suspending for breach (§11).
7. US side: ROSCA and any Virginia automatic-renewal law for a US seller's
   sale to South African buyers (8.5, § 4).
8. Stripe's role under POPIA (operator, its own responsible party, or both),
   the s21 agreement, the s72 gateway, and whether it belongs in the
   operator agreement's clause 6.1 (§ 3).
9. Retention: invoices at Stripe after deletion (5 years under the Tax
   Administration Act s29, or the US period), and the trial fingerprint
   "kept for good" against s14 (§ 3). Account deletion keeps the Stripe
   customer and its invoices as that record (built, billing.md § Deleting
   an account): is keeping the whole customer right, or should we delete
   it at Stripe (Stripe then keeps its own records under its own duties)?
10. Whether moving existing users to Free with limits is itself a material
    change, and whether 15 or 30 days' notice applies to price changes
    (§ 5, 8.8).
11. Purchase orders' own printed terms against ours (8.12).
12. For a tax adviser: the foreign e-services threshold and VAT-inclusive
    pricing if registration comes (8.4).
13. Deleting an account cancels a paid plan at once with no automatic
    refund (billing.md § Deleting an account). For a person's yearly plan,
    is that an early end under CPA s14 that owes 8.6's refund of the
    unused months unasked, and must the deletion page say so before the
    person confirms?
