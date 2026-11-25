# Anti-duplication protocol

The single most expensive failure on this project is rebuilding something
that already exists under a different name. Run this before declaring
anything missing.

## Search by meaning, not by name

For EVERY cluster below, search the Prisma schema and the codebase and
report what you found under whatever name it carries.

```
order state / status / workflow / transition / stage
claim / assign / lock / ownership / pull
change request / edit request / approval / pending modification
commitment / manifest / finalize / dispatch / handoff
settlement / reconciliation / statement / courier report / payout
wallet / fund / cash box / account / treasury / movement / ledger
closing / cash count / reconcile / day close
commission / payout / incentive / bonus / ledger entry
stock / inventory / reservation / allocation / movement / batch
return / refund / RMA / reverse logistics
note / comment / remark / log entry / annotation
audit / history / timeline / activity / event log
scheduler / cron / job / worker / queue / task
landing page / funnel / storefront / page builder
bundle / offer / package / tier / upsell
attribution / campaign / utm / pixel / conversion
country / region / governorate / city / market / tenant
```

## The verdict table

One row per concept:

```
CONCEPT | FOUND AS | FILE PATH | VERDICT
```

`VERDICT` is exactly one of:

| Verdict | Meaning |
|---|---|
| `REUSE` | Exists and is correct. Wire to it, change nothing. |
| `EXTEND` | Exists but lacks a field or a case. Add in place. |
| `CONFLICT` | Exists twice, or contradicts the contract. STOP and report. |
| `GENUINELY NEW` | No equivalent exists under any name. |

You may only build what you marked `GENUINELY NEW`, and only after the
user approves that list.

## Known-existing — the burden of proof is on building new

Verified present in this repository (Stage 0, 2026-09-19). Treat a claim
that any of them is missing as a search failure until proven otherwise:

orders (`Order.productId` held the single product; `OrderItem` was added in
Stage 3 and is the real lines — read it, not the legacy column) ·
RBAC with scoped permissions (`Role`, `RolePermission`, `UserPermission`,
`src/lib/authorization.ts`) · claim/lock/ownership (`src/lib/order-locks.ts`,
`OrderClaimHistory`) · idempotency (claim, lock, webhooks) · audit and
timeline (`AuditLog`, `OrderActivity`, `OrderStatusLog`) · three status
fields (`confirmationStatus`, `shippingStatus`, `settlementStatus`) ·
`FinancialTransaction` ledger (no wallets) · `ShippingBatch` ·
`DeliveryProvider` (no API integration) · Telegram intake · WhatsApp
inbox · landing pages (`LandingPage`, `LandingPageOffer`,
`LandingPageRecommendation`, `OrderAddOn`) · `Offer` · manufacturing
(`ProductionBatch`, `InventoryMovement`) · tracking pixels · AI assistant ·
geo context (`Country`, `Region`, `Store`, `UserCountryAccess`,
`UserStoreAccess`, `src/lib/geo-context.ts requireContext()`) — Stage 1 ·
route registry + page guard (`src/lib/route-registry.ts`,
`src/lib/page-guard.ts`) — Stage 2 · order lines and immutable notes
(`OrderItem`, `OrderNote`), one COD function (`src/lib/money.ts`), derived
core state and zone (`src/lib/order-state.ts`), per-line reservation
(`src/lib/reservation.ts`), shared order reference (`src/lib/order-ref.ts`)
— Stage 3 · pull-next queue with caps and auto-release
(`src/lib/confirmation-queue.ts`), business calendar
(`src/lib/business-calendar.ts`), customer risk (`src/lib/customer-risk.ts`),
`OrderChangeRequest`, `OrderIssue` — Stage 4 · delivery fee tables
(`DeliveryFee`, `src/lib/delivery-fees.ts`), preparation grouping and
shipment blocking checks (`src/lib/operations.ts`), label batch tokens and
Code 128 (`src/lib/labels.ts`), return receiving (`ReturnReceipt`) — Stage 5.

Also verified present (Stages 6–12, re-checked 2026-09-25) — every one of
these was listed as ABSENT above until the list was re-run against the tree:

settlement statements, lines, receipts and matching (`CourierStatement`,
`StatementLine`, `StatementReceipt`, `SettlementMatch`,
`src/lib/settlement.ts`) · wallets, movements, transfers and daily closing
(`Wallet`, `WalletMovement`, `WalletTransfer`, `DailyClosing`) ·
**commission rules and ledger** (`CommissionRule`, `CommissionEntry`,
`CommissionPeriod`, `src/lib/commission.ts`) · courier integration
including LogesTechs (`src/lib/couriers/`, `logestechs.ts`, `apply-event.ts`,
`city-id.ts`; the status webhook was cancelled on 2/11), dispatch, scope and transfer (`src/lib/courier-*.ts`) ·
`getZone(state)` (`src/lib/order-state.ts`) · blacklist, phone-keyed and
company-wide (`src/lib/blacklist.ts`) · scheduler and worker
(`src/lib/jobs/runner.ts`, `definitions.ts`) · apps registry (`App`,
`AppInstall`, `AppDelivery`) · discount alerts
(`src/components/screens/DiscountAlertsScreen.tsx`) · order split and
replacement (`Order.parentOrderId`, `Order.replacesOrderId`) · immutable
notes (`OrderNote`).

## Verified ABSENT (re-checked 2026-09-25) — do not assume they exist

QR on labels (Code 128 barcodes only).

NO LONGER ABSENT (19/11, warehouse plan W0a): a stock LOCATION dimension. `Warehouse` (a place of one
country) and `UserWarehouseAccess` (keepers) exist; `ProductionBatch.warehouseId`, `InventoryMovement.warehouseId`,
`ShippingBatch.warehouseId` and `Order.sourceWarehouseId` exist but are INERT until a store is placed —
units still live only in batches. Extend `src/lib/warehouses.ts`; never add a second quantity table.
(19/11, W1a) A store becomes «placed» once: `WarehousePlacement` (one row per store) + `src/lib/warehouse-placement.ts`
(`storeIsPlaced` reads the row). Units change place inside one store ONLY through `src/lib/batch-split.ts`
(`splitBatch`: a twin row, `quantityProduced` 0, the parent's cost and dates) — never draw-down + receive.
(20/11, W8a) A COMBINATION's count (size/colour, `ProductVariant.onHand`) was already its own number beside the batches;
in a placed store it is split per warehouse in `ProductVariantStock` (one «بلا مكان» row with no warehouse) and written
ONLY by `src/lib/variant-stock.ts` (`onHand` = Σ of the places; a `VariantStockMovement` line per change). The product's
units still live only in batches — this splits the existing combination count, it is not a second count of the product.
(20/11, W3a) A transfer between two warehouses of ONE store: `StockTransfer` + `StockTransferLine` and
`src/lib/stock-transfers.ts` (send = split into twins on the road, receive by count, a shortfall approved by a third person,
cancel before receipt; kind read by `stock-transfer-kind.ts`). Between stores / countries is NOT built (refused by the door).
(20/11, W6a) Goods out of a warehouse for good (not a sale): `StockExit` + `StockExitLine` and `src/lib/stock-exits.ts`
(request with one reason of `stock-exit-reasons.ts` → held in the free stock → a DIFFERENT person approves through
`receiving.drawDownStock` with `warehouseId`, or rejects). The free stock of a warehouse is ONE function: `stock-transfers.freeStockOf`.
Nothing posted to a profit, a wallet or an expense.
(20/11, W7a) The same article in two stores: `ProductPair` and `src/lib/product-pairs.ts` (proposed by equal sku, then equal
name — `order-parser.foldForMatch` — and SAVED by a person; one twin per product per other store, held by the database's
unique keys). Doors `/api/inventory/pairs` (key `inventory.transfer`). Nothing reads it yet — the transfer between stores
(W7b) will; never link two stores' products another way.

(22/11, F3) A PARTNER'S WITHDRAWAL has TWO records, on purpose for now: the cash one is the wallet movement of category
PARTNER_DRAW (`/api/finance/partners/draws`, read by `partner-statement.ts`); the RECORD-ONLY one is `PartnerWithdrawal` +
`PartnerStandingAmount` and `src/lib/partner-withdrawals.ts` (tab «المسحوبات» on «الأرباح», key `finance.partners`): per store and
currency, totals never across currencies, a cancel is a reversing row. It moves no wallet, and no profit or statement reads it —
linking it to the cash (a movement behind an approval) is the open follow-up. Never add a third.

**This list rots.** It was written at Stage 0 and went eleven stages
without being re-run, by which point every line but two was false — and one
of the false lines said the commission ledger did not exist, which is the
single most expensive thing to rebuild in this repository. Re-run it
against the tree before trusting it, and correct it in the same commit as
whatever you found.

## Known conflicts awaiting a decision

- Two COD/profit computations: `computeFinancials` (`finance-workflow.ts`)
  and `calculateRealProfit` (`financial.ts`).
- Four implementations of `confirmed_count` / `delivery_rate`, with three
  different denominators. STILL OPEN.
- Two offer models: `Offer` and `LandingPageOffer`.
- Pixel stored twice: `LandingPage.metaPixelId` and `TrackingPixel`.
- RESOLVED in Stage 3: order numbers now come from src/lib/order-ref.ts.
- Money mostly `Float`; the D3 snapshot fields are `Decimal(12,2)` and
  `CommissionEntry.amount` is `Decimal(14,3)`.
- RESOLVED in Stage 2: WAREHOUSE and CONFIRMATION_SUPERVISOR added; the
  other contract roles map onto existing ones.
- RESOLVED 2026-09-25: the two commission engines. `Order.moderatorCommission`
  is RETIRED — nothing writes or reads it, and `src/lib/commission-one-source.test.ts`
  keeps it that way. The column stays in the schema because it holds what the
  old engine wrote for orders that predate the ledger. `User.commissionRate`
  still exists as a column but pays nobody; commission comes from
  `CommissionRule` and accrues on delivery.
- Legacy Order.sellingPrice is the TOTAL for the quantity, not a unit price.
- Public landing checkout still validates Syrian phones and cities only.

## Stage-specific warnings

| Stage | What may already exist under another name |
|---|---|
| 6 — scheduler | EXISTS: `src/lib/jobs/runner.ts` + `definitions.ts`. Add a job definition, do not build a runner |
| 7 — notes | EXISTS: `OrderNote`, immutable. Add a `kind`, do not build a second table |
| 8 — reservation | reservation per ORDER, needing a move to per LINE. That is an EXTEND, never a new table |
| 10 — custody | a location, zone or warehouse dimension on stock movements |
| 11 — storefront | landing pages and bundles DO exist. Assemble, do not rebuild |
| 9 — split | EXISTS: `Order.parentOrderId` / `Order.replacesOrderId` |
| 12 — apps | EXISTS: `App`, `AppInstall`, `AppDelivery` |

## The rule

If you create a table, field or service whose job is already done under
another name, that is a defect, not a feature. Report it as a conflict
and stop.
