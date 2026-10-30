-- ============================================================================
-- READ-ONLY. Orders whose COLUMNS disagree with their LINES (the ORD-2026-0733 shape).
-- The transaction is READ ONLY and ends in ROLLBACK; run it with a read-only DB role anyway.
-- NOT a migration and NOT a backfill: it only counts and lists, it never fixes anything. It sits in this folder so the
-- pre-deploy guide (docs/ops/PRE-DEPLOY-30-10.md) can point at it. Nothing here writes.  Real tables/columns (prisma/schema.prisma, @@map; camelCase quoted columns):
--   orders, order_items, order_add_ons, order_change_requests, shipping_batches, countries.
--
-- WHAT "DRIFT" MEANS (the same arithmetic as COD_DRIFT / computeCod, src/lib/order-line-edit.ts:890-905):
--   expected quantity     = SUM(order_items.quantity)                 vs orders.quantity      (gifts are NOT in it)
--   expected freeQuantity = SUM(order_items.freeQuantity)             vs orders."freeQuantity" (information only)
--   expected sellingPrice = SUM(lineTotal + discountShare)            vs orders."sellingPrice"
--   expected totalAmount  = sellingPrice_lines - SUM(discountShare) + add-ons
--                           + (priceIncludesDelivery ? 0 : coalesce(deliveryFee, shippingCost))   vs orders."totalAmount"
--   tolerance             = half a minor unit per line (countries."minorUnit"; 2 when the order has no country)
-- Reserved: reserved_now = SUM("reservedQty" of lines + add-ons). MEANINGFUL only for a confirmed order that has not left:
--   reserved_gap_vs_order = reserved_now - (orders.quantity + orders."freeQuantity" + add-on units);
--   negative = the shelf was told fewer units than the order columns say (0733: -9).
-- risk: 1 with the courier . 2 sealed (waybill printed) . 3 in a batch not handed over . 4 confirmed, not shipped
--       5 not confirmed . 6 closed / history
--
-- Closed orders (risk 6) are compared on quantity and sellingPrice ONLY: returns/statements rewrite totalAmount on purpose.
-- FALSE POSITIVES to eyeball before acting: a delivery fee overridden by hand (deliveryFeeOverrideReason), a discount typed
-- on the order that was never spread on the lines, and risk 6 (history).
-- To scope one company add   AND "companyId" = '<uuid>'   in the WHERE of the final SELECT of Query 1 and Query 2.
-- ============================================================================
BEGIN READ ONLY;

-- ---------------------------------------------------------------- Query 1 : the COUNT, by class
WITH per_line AS (
  SELECT i."orderId",
         count(*)                               AS n_lines,
         sum(i.quantity)                        AS q_paid,
         sum(i."freeQuantity")                  AS q_free,
         sum(i."lineTotal" + i."discountShare") AS gross,
         sum(i."discountShare")                 AS shares,
         sum(i."reservedQty")                   AS reserved_lines
  FROM order_items i
  GROUP BY i."orderId"
),
add_on AS (
  SELECT a."orderId",
         sum(round((a.quantity * a.price)::numeric, 6)) AS amount,
         sum(a.quantity)                                AS units,
         sum(a."reservedQty")                           AS reserved_addons
  FROM order_add_ons a
  GROUP BY a."orderId"
),
calc AS (
  SELECT o.id, o."companyId", o."orderNumber", o."confirmationStatus", o."shippingStatus", o."settlementStatus",
         o."shippingBatchId", b."batchNumber", b.status AS batch_status, o."shippedAt", o."labelPrintedAt", o."trackingNumber",
         o.quantity AS order_qty, o."freeQuantity" AS order_free,
         o."sellingPrice"::numeric AS order_selling, o."totalAmount"::numeric AS order_total,
         o."priceIncludesDelivery" AS includes_delivery,
         coalesce(o."deliveryFee", o."shippingCost", 0)::numeric AS fee,
         (o."deliveryFee" IS NOT NULL AND o."deliveryFee" <> o."shippingCost") AS two_fees,
         coalesce(c."minorUnit", 2) AS mu,
         l.n_lines, l.q_paid, l.q_free, l.gross, l.shares,
         coalesce(ad.amount, 0) AS addons,
         coalesce(ad.units, 0)  AS addon_units,
         l.reserved_lines + coalesce(ad.reserved_addons, 0) AS reserved_now,
         ( o."shippedAt" IS NOT NULL
           OR o."shippingStatus" IN ('SHIPPED','OUT_FOR_DELIVERY','DELIVERED','PARTIALLY_DELIVERED','FAILED_DELIVERY','RETURN_REQUESTED','RETURNED')
           OR b.status IN ('SHIPPED','CLOSED') ) AS at_courier,
         ( o."confirmationStatus" IN ('REJECTED','CANCELLED')
           OR o."shippingStatus" IN ('CANCELLED','DELIVERED','PARTIALLY_DELIVERED','RETURNED') ) AS closed
  FROM orders o
  JOIN per_line l              ON l."orderId" = o.id
  LEFT JOIN add_on ad          ON ad."orderId" = o.id
  LEFT JOIN countries c        ON c.id = o."countryId"
  LEFT JOIN shipping_batches b ON b.id = o."shippingBatchId"
),
expected AS (
  SELECT calc.*,
         (0.5 / power(10, mu)) * greatest(1, q_paid) AS tol,
         round(gross, mu) AS exp_selling,
         round(gross - shares + addons + CASE WHEN includes_delivery THEN 0 ELSE fee END, mu) AS exp_total,
         q_paid + q_free + addon_units       AS units_by_lines,
         order_qty + order_free + addon_units AS units_by_order
  FROM calc
),
drift AS (
  SELECT e.*,
         (order_qty  <> q_paid)                   AS qty_drift,
         (order_free <> q_free)                   AS free_drift,
         (abs(order_selling - exp_selling) > tol) AS selling_drift,
         (NOT closed AND abs(order_total - exp_total) > tol) AS total_drift,
         CASE
           WHEN closed                             THEN 6
           WHEN at_courier                         THEN 1
           WHEN "labelPrintedAt" IS NOT NULL       THEN 2
           WHEN "shippingBatchId" IS NOT NULL      THEN 3
           WHEN "confirmationStatus" = 'CONFIRMED' THEN 4
           ELSE 5
         END AS risk
  FROM expected e
  WHERE (order_qty <> q_paid)
     OR (abs(order_selling - exp_selling) > tol)
     OR (NOT closed AND abs(order_total - exp_total) > tol)
)
SELECT risk,
       CASE risk WHEN 1 THEN 'with the courier' WHEN 2 THEN 'sealed (waybill printed)' WHEN 3 THEN 'in a batch, not handed over'
                 WHEN 4 THEN 'confirmed, not shipped' WHEN 5 THEN 'not confirmed' ELSE 'closed / history' END AS class,
       count(*)                              AS orders,
       count(*) FILTER (WHERE qty_drift)     AS qty_drift,
       count(*) FILTER (WHERE selling_drift) AS selling_drift,
       count(*) FILTER (WHERE total_drift)   AS total_drift,
       sum(abs(order_total - exp_total))     AS sum_abs_total_gap
FROM drift
GROUP BY risk
ORDER BY risk;

-- ---------------------------------------------------------------- Query 2 : the LIST, most dangerous first
WITH per_line AS (
  SELECT i."orderId",
         count(*)                               AS n_lines,
         sum(i.quantity)                        AS q_paid,
         sum(i."freeQuantity")                  AS q_free,
         sum(i."lineTotal" + i."discountShare") AS gross,
         sum(i."discountShare")                 AS shares,
         sum(i."reservedQty")                   AS reserved_lines
  FROM order_items i
  GROUP BY i."orderId"
),
add_on AS (
  SELECT a."orderId",
         sum(round((a.quantity * a.price)::numeric, 6)) AS amount,
         sum(a.quantity)                                AS units,
         sum(a."reservedQty")                           AS reserved_addons
  FROM order_add_ons a
  GROUP BY a."orderId"
),
calc AS (
  SELECT o.id, o."companyId", o."orderNumber", o."confirmationStatus", o."shippingStatus", o."settlementStatus",
         o."shippingBatchId", b."batchNumber", b.status AS batch_status, o."shippedAt", o."labelPrintedAt", o."trackingNumber",
         o.quantity AS order_qty, o."freeQuantity" AS order_free,
         o."sellingPrice"::numeric AS order_selling, o."totalAmount"::numeric AS order_total,
         o."priceIncludesDelivery" AS includes_delivery,
         coalesce(o."deliveryFee", o."shippingCost", 0)::numeric AS fee,
         (o."deliveryFee" IS NOT NULL AND o."deliveryFee" <> o."shippingCost") AS two_fees,
         coalesce(c."minorUnit", 2) AS mu,
         l.n_lines, l.q_paid, l.q_free, l.gross, l.shares,
         coalesce(ad.amount, 0) AS addons,
         coalesce(ad.units, 0)  AS addon_units,
         l.reserved_lines + coalesce(ad.reserved_addons, 0) AS reserved_now,
         ( o."shippedAt" IS NOT NULL
           OR o."shippingStatus" IN ('SHIPPED','OUT_FOR_DELIVERY','DELIVERED','PARTIALLY_DELIVERED','FAILED_DELIVERY','RETURN_REQUESTED','RETURNED')
           OR b.status IN ('SHIPPED','CLOSED') ) AS at_courier,
         ( o."confirmationStatus" IN ('REJECTED','CANCELLED')
           OR o."shippingStatus" IN ('CANCELLED','DELIVERED','PARTIALLY_DELIVERED','RETURNED') ) AS closed
  FROM orders o
  JOIN per_line l              ON l."orderId" = o.id
  LEFT JOIN add_on ad          ON ad."orderId" = o.id
  LEFT JOIN countries c        ON c.id = o."countryId"
  LEFT JOIN shipping_batches b ON b.id = o."shippingBatchId"
),
expected AS (
  SELECT calc.*,
         (0.5 / power(10, mu)) * greatest(1, q_paid) AS tol,
         round(gross, mu) AS exp_selling,
         round(gross - shares + addons + CASE WHEN includes_delivery THEN 0 ELSE fee END, mu) AS exp_total,
         q_paid + q_free + addon_units       AS units_by_lines,
         order_qty + order_free + addon_units AS units_by_order
  FROM calc
),
drift AS (
  SELECT e.*,
         CASE
           WHEN closed                             THEN 6
           WHEN at_courier                         THEN 1
           WHEN "labelPrintedAt" IS NOT NULL       THEN 2
           WHEN "shippingBatchId" IS NOT NULL      THEN 3
           WHEN "confirmationStatus" = 'CONFIRMED' THEN 4
           ELSE 5
         END AS risk
  FROM expected e
  WHERE (order_qty <> q_paid)
     OR (abs(order_selling - exp_selling) > tol)
     OR (NOT closed AND abs(order_total - exp_total) > tol)
)
SELECT d."orderNumber"        AS order_number,
       d."confirmationStatus" AS confirmation_status,
       d."shippingStatus"     AS shipping_status,
       d."settlementStatus"   AS settlement_status,
       CASE d.risk WHEN 1 THEN 'with the courier' WHEN 2 THEN 'sealed (waybill printed)' WHEN 3 THEN 'in a batch, not handed over'
                   WHEN 4 THEN 'confirmed, not shipped' WHEN 5 THEN 'not confirmed' ELSE 'closed / history' END AS class,
       (d."labelPrintedAt" IS NOT NULL) AS label_printed,
       d."batchNumber"        AS batch_number,
       d.batch_status,
       d.at_courier           AS with_courier,
       d."trackingNumber"     AS tracking_number,
       d.order_qty,   d.q_paid    AS lines_qty,
       d.order_free,  d.q_free    AS lines_free,
       d.order_selling, d.exp_selling AS lines_selling,
       d.order_total,   d.exp_total   AS lines_total,
       (d.order_total   - d.exp_total)   AS total_gap,     -- positive = the order says MORE than its lines (customer owes more than the courier is told)
       (d.order_selling - d.exp_selling) AS selling_gap,
       d.two_fees             AS two_fee_sources,
       CASE WHEN d."confirmationStatus" = 'CONFIRMED' AND NOT d.at_courier AND NOT d.closed THEN d.reserved_now END                    AS reserved_now,
       CASE WHEN d."confirmationStatus" = 'CONFIRMED' AND NOT d.at_courier AND NOT d.closed THEN d.units_by_lines END                  AS reserved_expected_by_lines,
       CASE WHEN d."confirmationStatus" = 'CONFIRMED' AND NOT d.at_courier AND NOT d.closed THEN d.units_by_order END                  AS reserved_expected_by_order_cols,
       CASE WHEN d."confirmationStatus" = 'CONFIRMED' AND NOT d.at_courier AND NOT d.closed THEN d.reserved_now - d.units_by_order END AS reserved_gap_vs_order,
       r.id                   AS last_approved_request,
       r.intent,
       r."decidedAt"          AS request_decided_at,
       r."appliedAt"          AS request_applied_at,
       r.keys                 AS request_fields,
       d.id                   AS order_id,
       d."companyId"          AS company_id
FROM drift d
LEFT JOIN LATERAL (
  SELECT q.id, q.intent, q."decidedAt", q."appliedAt",
         CASE WHEN jsonb_typeof(q.changes) = 'object'
              THEN (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(q.changes) AS k) END AS keys
  FROM order_change_requests q
  WHERE q."orderId" = d.id AND q.status = 'APPROVED'
  ORDER BY q."decidedAt" DESC NULLS LAST
  LIMIT 1
) r ON TRUE
ORDER BY d.risk, abs(d.order_total - d.exp_total) DESC, d."orderNumber";

-- ---------------------------------------------------------------- Query 3 : orders with NO lines (not comparable; information)
SELECT o."orderNumber", o."confirmationStatus", o."shippingStatus", o.quantity, o."sellingPrice", o."totalAmount"
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i."orderId" = o.id)
  AND o."confirmationStatus" NOT IN ('REJECTED','CANCELLED')
ORDER BY o."createdAt" DESC
LIMIT 200;

ROLLBACK;
