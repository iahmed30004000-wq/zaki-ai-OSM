# Stages — the order of work

> **Revised order (approved 2026-09-19).** Stage 0 found that most of the
> backend this file assumes does not exist, so foundations come first.
> The stage bodies below still hold; only the sequence changed:
>
> 1. Geo foundation — Country, Region, Store, access, requireContext  ✅ done
> 2. Shell + store scope — pickers, navigation, 403/404 guard, old UI and
>    CRM deleted, requireContext wired into every order API  ✅ done
> 3. Order core — derived state + getZone, OrderItem + per-line reservation,
>    one COD function (src/lib/money.ts), merchant reference, OrderNote  ✅ done
> 4. Confirmation centre — pull-next with caps, business-hours auto-release,
>    postponed, entry issues, change requests  ✅ done
> 5. Operations — preparation, shipments with blocking checks, labels,
>    tracking, returns, delivery-fee tables and couriers  ✅ done
>    - Courier seam built (src/lib/couriers). Every provider is MANUAL until
>      someone registers an adapter AND turns apiEnabled on for it.
>    - A courier feed may never assert DELIVERED / RETURNED / CANCELLED, and
>      an unrecognised code maps to null, never a near match — a test pins it.
>    - LogesTechs adapter BUILT from their documentation (v. 9-6-2026). It
>      registers only when every env var is set, and the provider still needs
>      code=LOGESTECHS plus apiEnabled. Their PARTIALLY_DELIVERED stays null
>      until Stage 9. Only open question left: do they support webhooks
>      (closed 2/11: the owner cancelled the webhook, statuses come from
>      the API poll).
>    - مندوب (AGENT) vs COMPANY: away from an agent a parcel moves directly;
>      away from a company it is recalled and a REPLACEMENT order is raised
>      (replacesOrderId), re-entering preparation. Never overwrite the
>      provider — the parcel is with them under their barcode.
> 6. Finance — statements, receipts, matching, wallets, transfers,
>    closing, commission rules  ✅ done
>    - Three sequential entities; money moves ONLY at statement approval.
>      Approval refuses: no receipts, no matching run, unexplained gap.
>      Verified end to end against the running app, not just in tests.
>    - Corrections are reversing entries only — no edit, no delete.
>    - Closing: difference needs a written reason, an unexplained one blocks
>      the next day, and the recorder cannot approve. SETTLEMENT_OFFICER and
>      ACCOUNTANT are deliberately different pairs of hands; both are seeded.
>    - Commission rules are dated data. Revenue base = totalAmount − fee
>      (totalAmount holds the COD, so this is right under both pricing modes).
>    - Accrual runs on a schedule now (Stage 7 job accrue-commission).
> 7. Scheduler worker  ✅ done
>    - scripts/worker.ts — a real process, no Redis/cron. --once, --job=NAME.
>    - Six jobs, each calling the service that owns the rule. All idempotent.
>    - runJob: skips a live RUNNING row, takes over one older than 30 min,
>      records every attempt, re-throws failures. "Overdue" = last SUCCESS vs
>      the job's interval with grace. Backoff, alert after 3 in a row.
>    - Courier sync applies in-transit states ONLY, through the transition
>      machine. It can never assert DELIVERED/RETURNED/CANCELLED.
>    - /admin/jobs answers "is anything quietly not running", and says WHY a
>      job did nothing.
>    - This closed the Stage 6 gap: commission now accrues on a schedule.
> 8. Control, growth, settings, admin  ◐ مُعظمها
>    - Blacklist: keyed on the PHONE via canonicalPhone, company-wide,
>      enforced at ALL FOUR intakes. Public pages get a neutral refusal.
>      Released, never deleted.
>    - Intelligence: analysis with a minimum sample and an explicit "not
>      enough data". Silence is a stated answer.
>    - Inventory movements + discount alerts shipped.
>    - Campaigns NOT built: needs ad-platform credentials from the user. A
>      campaigns screen with no cost data cannot answer the only question
>      campaigns are for.
> 9. Partial delivery ✅ / split ◐ / courier custody ✗
>    - PARTIAL: the fee is charged IN FULL — the courier travelled. Waived
>      only when nothing at all was taken. collectedAmount is null on every
>      ordinary order, which is how settlement tells a partial apart.
>    - Refused units are REPORTED, never auto-restocked.
>    - LogesTechs PARTIALLY_DELIVERED maps now but stays in
>      COURIER_CANNOT_ASSERT — their feed says it happened, not what it was
>      worth.
>    - Split: schema is in (parentOrderId, children get SY-0044-A) but the
>      service and UI are NOT built.
>    - Courier custody (Stage 10): untouched.
> 10. Single product store · 11. App store
>
> Cleared 2026-09-20 (were blockers):
>  - CRM module: models gone, migration 20260920160000_drop_crm drops the
>    eight tables and REFUSES to run if any holds a row. preflight.sql answers
>    "is production empty?" read-only. Still to do: run it on production and
>    deploy, which is the user's call.
>  - Public landing checkout now validates phone and city against the store's
>    OWN country (src/lib/phone-rules.ts + the Region table). The hard-coded
>    Syrian lists are deleted.
>  - Statement import reads the courier's REAL .xlsx (src/lib/xlsx-reader.ts,
>    hand-written on purpose — third-party file, money path). The NET column
>    is the amount; the merchant ref is read from the notes when there is no
>    reference column. Verified on the user's own 145-line statement.
>  - Region binding: every intake path resolves a Region via src/lib/regions.ts.
>    Without it an order cannot be priced or shipped.
>  - Stock: receiving opens a BATCH. On-hand is the sum of batch remainders, so
>    a movement that touches no batch adds nothing — that was the phantom
>    "shortage" for stock that had just been entered.
>  - Order numbers come from the highest issued, not a row count, and the retry
>    wraps the transaction (a failed statement aborts it on Postgres).

One stage at a time. Do not open the next before the current is approved.
Commit after every stage; a bad stage should cost one revert, not a
rebuild.

## Stage 0 — Discovery
Service inventory table plus the anti-duplication verdict table plus the
route map. **No code.** Wait for approval.

## Stage 1 — Shell
Country picker, store picker, layout, navigation, routing, role
visibility, 403 enforcement, RTL, design tokens.
Old shell and old routes DELETED in the same commit.

## Stage 2 — Confirmation centre
Four screens: queue, mine, postponed, issues.

## Stage 3 — Operations
Five screens: preparation, shipments, labels, tracking, returns.

## Stage 4 — Inventory and finance
Nine screens: receiving, balances, movements, collection, matching,
wallets, transfers, closing, profit.

## Stage 5 — Control, growth, apps, settings, admin
The remaining screens.

## Stage 6 — Scheduler worker  ← highest value per hour

A real background process, not API endpoints. BullMQ + Redis, or
node-cron in a separate container. Runs independently of any browser.

```
every 2 min   courier status sync for shipments in transit
every 1 min   SLA escalation for pending change requests
every 5 min   auto-release claims with no attempt in 90 business minutes
daily 08:00   surface postponed orders due within lead days
daily 16:45   daily closing reminder per wallet
daily 09:00   alert: returns announced but not received, oldest first
daily 06:00   ad spend sync
daily 23:00   commission accrual
```

Requirements: every job idempotent; a run log per job with job_name,
started_at, finished_at, status, error; an admin screen showing last run
and last status, red when a window is missed; business-calendar aware per
country so SLA counters freeze outside hours and on weekend days; retry
with backoff and an alert after 3 consecutive failures; a barcode
returning 404 three consecutive times raises "shipment missing at
courier" instead of silent polling.

Without this layer half the system is inert. It waits for a human to open
a screen.

## Stage 7 — Order notes as the context layer
Immutable notes, surfaced on settlement exceptions, return receiving,
tracking and order detail. An eye icon with a count wherever notes exist.

## Stage 8 — Reservation per line
`OrderItem.reserved_qty`. Proportional discount allocation stored per
line. This fixes the wrong single-product assumption the system was built
on.

## Stage 9 — Split and partial delivery
Split: `parent_order_id`, children get suffixed numbers (SY-4401-A).
Delivery fee charged PER SHIPMENT, never divided, shown before confirming.
PARTIALLY_DELIVERED with post-event settlement comparison. A pending
cancellation auto-rejects with "too late - already delivered" when a
DELIVERED event arrives (the courier's status webhook was cancelled on
2/11, and a feed never asserts DELIVERED — the door and the statement do).

## Stage 10 — Courier custody
`COURIER_CUSTODY` inventory location. Enables: same-run item reassignment
with no second fee, add-on orders with no additional delivery fee, and the
three wrong-item paths (before shipment, with courier, at customer).
Track `picking_error_rate` per warehouse user.

## Stage 11 — Single product store and landing pages

> Revised 2026-10-11 (Stage 1 of the storefront overhaul): MULTI_PRODUCT
> is the main path for new stores; SINGLE_PRODUCT stays supported for the
> shops that already wear it but is no longer offered. A product appears
> in the catalogue only through a published page with `showInStore`; its
> card opens `/s/<store>/p/<handle>`, which renders that page inside the
> store shell through the same `LandingPageView` `/lp/<slug>` uses, with
> `?c=` carried and one canonical URL. Until the seller's one-press
> («اعرض كل الصفحات المنشورة») the catalogue serves exactly what it
> served before, and the press and the switch are one atomic act. Every
> storefront screen names the store it edits with one shared bar.
> New landing pages created with a product default to shown (unpublished
> still never appears).

Landing pages and bundle quantities ALREADY EXIST. Assemble them.
Building a second landing page system is a failure of the task.

- Store type MULTI_PRODUCT | SINGLE_PRODUCT. A single-product store binds
  to exactly ONE ProductMarket. No catalog, no cart. Its storefront IS the
  landing page. Domain or subdomain per store.
- Section library, reorderable, each on or off: announcement bar, hero,
  countdown, gallery, benefits, story, social proof, reviews, comparison,
  FAQ, guarantee, sticky order button, offer block, checkout, thank-you.
- Arabic RTL first, mobile first. No external blocking scripts. LCP under
  2.5s on 3G. A slow page loses more orders than a weak offer.
- Three offer types: QUANTITY_TIERS, MULTI_PRODUCT_BUNDLE, BUY_X_GET_Y.
  Free items are real order lines at zero price — they consume stock and
  appear in COGS. Free delivery is never an offer property; it comes only
  from `ProductMarket.price_includes_delivery`.
- Checkout: name, phone, region, address, offer, optional note. No
  account, no email. Phone is the identity. Live COD summary from the
  SAME COD function.
- Submission guards server-side: duplicate flagged not merged, blacklist
  checked company-wide with a neutral message, rate limit per IP and
  phone, honeypot plus minimum time-on-page, attribution captured once.
- The order enters the SAME pipeline: state NEW, shared pool, merchant
  reference. There is no separate storefront flow.
- Store cloning copies structure but never prices, costs, fees or pixels.

## Stage 12 — App store foundation
`App`: key, name, category, description, icon, version, publisher, scopes,
install_target, settings_schema, enabled. Installed per store. An app may
register landing-page sections, dashboard widgets, settings panels and
scheduled jobs. An app may NEVER write a fund movement, change a price,
approve a settlement or edit the audit log — regardless of scopes.
First two apps ship internal: Reviews and Countdown.
