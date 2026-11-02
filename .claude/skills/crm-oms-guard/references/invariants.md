# Invariants — the logic that never bends

Violating any line here is a defect, not a design choice. If existing code
contradicts one, report it and stop.

## Money

```
COD = price − discount + delivery fee
If price_includes_delivery:
    COD = price − discount, and the fee is deducted from revenue
If ANY line includes delivery, the whole order does.
ONE function computes this, used by every screen and service.
```

- Merchant reference is auto-generated for every order including POS and
  landing pages. Read-only, mandatory, sent in the courier's dedicated
  reference field, never in notes.
- Delivery status, settlement and collection are THREE separate fields.
  Never merged, never inferred from one another.
- No fund movement is posted before settlement approval.
- No hard delete of orders or financial records. Reversing entries only,
  linked to the original.
- The user who records movements cannot approve the closing. Two
  permissions that never sit on one user except the owner.
- Exchange rates are entered manually, stored with the transfer, and
  never recalculated.
- Decimal precision comes from the currency's minor unit. Never a single
  global rounding rule.

## Order state machine

Core states are a code enum. User additions are sub-statuses only.

```
NEW → CLAIMED → CONFIRMED → PREPARING → READY_TO_SHIP → SHIPPED
                                                           ↓
                              DELIVERED | PARTIALLY_DELIVERED | WAITING_RETURN
```

Supporting: NO_ANSWER, POSTPONED, IN_TRANSFER, RETURNED, CANCELLED,
NEEDS_REVIEW, VOIDED.

The nine invariants:

1. Zone is derived: `getZone(state)`. No stored column, ever.
2. NEEDS_REVIEW stores `return_to_state` on entry and restores it on exit.
   It never falls back to NEW unless NEW was the origin.
3. Reservation is released in the SAME transaction on CANCELLED, VOIDED,
   unconfirm, and NEEDS_REVIEW entered from any post-confirmation state.
4. No cancellation after SHIPPED. It becomes `cancel_requested` and ends
   as RETURNED with a reason.
5. PARTIALLY_DELIVERED carries delivered lines, returned lines,
   collected_amount, and the FULL delivery fee — the courier travelled.
6. IN_TRANSFER exists for courier-to-courier moves. The order is not
   SHIPPED again until the new courier confirms pickup.
7. A blocking change request stops OUR forward transitions only. Courier
   feed events (the API poll; the status webhook was cancelled on 2/11)
   are always recorded, and flag the pending request as
   "changed during review".
8. Claim caps: 40 owned with no logged attempt AND 120 owned total.
9. VOID is refused for any order that has ever reached SHIPPED.

Auto-release:
- CLAIMED with no attempt for 90 business minutes
- NO_ANSWER with no follow-up attempt within 24 business hours
- POSTPONED past its due date by 2 business days

Order age is time in the CURRENT state. `created_at` is for reporting only.

## Inventory

- Reservation is PER LINE (`OrderItem.reserved_qty`), never per order.
- An order with one unreserved line cannot reach READY_TO_SHIP.
- Discount is allocated across lines proportionally and stored per line.
  Without this, partial returns refund the wrong amount.
- Stock enters only through a supplier batch or an explicit adjustment
  with a reason. Final unit cost = unit cost + (shipping and customs ÷ qty).
- Stock never re-enters inventory before physical count and inspection.
- `allow_negative_stock` is a per-country setting, enforced at shipment
  creation, not order creation. There is no third state: it is allowed
  with flagging and a daily alert, or refused with the order staying
  READY_TO_SHIP in an exceptions list.
- COURIER_CUSTODY is a real location. Goods with the courier are neither
  in the warehouse nor with the customer.
- Warehouses belong to a country. Cross-border transfer is refused by
  rule, not by warning.

## Settlement and collection — three sequential entities

```
Statement : what the courier says it owes. File hash, no duplicate import.
Receipt   : what actually arrived. MANY lines, each with its own wallet,
            currency and amount. Sum must equal the statement total or
            the gap is flagged and needs a written explanation.
Matching  : runs on demand AFTER the receipt. Single key: merchant
            reference, then courier barcode. NEVER phone.
```

Matching produces three queues with editable actions: matched, mismatched,
missing. A partially delivered order is compared against the post-event
expected amount, never the original total.

## Customer

- Customer is company-wide: one phone, one person, one risk history.
- CustomerMarket holds per-country activity.
- Blacklist and duplicate detection are company-wide, never country-scoped.
- Country is determined by the DELIVERY ADDRESS, never the phone prefix.
- Risk tiers: return rate over 6 months or last 10 orders. Under 15% safe,
  15–40% watch, over 40% with 3+ orders or two returns within 60 days is
  high risk. High risk requires prepayment or supervisor approval and is
  excluded from automated confirmation.

## Notes are the context layer

`OrderNote: id, order_id, body, author_id, created_at, kind`
kind = follow_up | return | settlement | internal

Immutable. No edit, no delete. Corrections are new notes. Surfaced on
settlement exceptions, return receiving, tracking and order detail.

**Never add a typed field for a situation a note already covers.**
Specifically not: partial payment, customer debt, received_by, collected
currency or rate, "collected by courier not remitted".

## Commission

- Accrued on DELIVERED. Payable only after settlement approval.
- Rules stored as DATA with `effective_from`. Changing a rule never
  recalculates a closed period.
- Delivery-rate tiers with a minimum sample of 30 orders.
- Cross-sell from `order_items.added_by` and `added_stage`, verified
  against the original order text.
- Exclusions: duplicate-cancelled, moderator data error, stuck at courier
  over a week, administratively voided.
- One reference currency, manual exchange rate stored with the statement.
- Monthly statement locked after approval. Corrections are reversing
  entries.
- There is ONE commission source. Any legacy store-level commission rate
  is disabled for employees.

## Attribution

Order fields: `source_type, page_id, campaign_id, adset_id, ad_id,
ctwa_clid`. Captured ONCE, never overwritten.

WhatsApp CTWA sends `referral.source_id` and `ctwa_clid` on the FIRST
message only. Attribution must be enabled in WhatsApp Business settings
or referral never arrives.

Conversion values sent to ad platforms use the COLLECTED amount at
DELIVERED, not the ordered amount, deduplicated by event_id. The
per-campaign delivery rate is a reported metric, never a multiplier
applied to events.

## Frontend

The UI computes nothing the backend already computes. It NEVER calculates
COD, delivery fee, discount allocation, available stock, days in transit,
SLA remaining, commission, profit, delivery rate, risk tier, or expected
settlement amount. If a value is missing from a response, extend the
endpoint. A number that exists in two places will diverge.
