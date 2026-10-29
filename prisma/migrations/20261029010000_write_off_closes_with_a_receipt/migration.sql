-- EVERY ORDER ALREADY WRITTEN OFF AS A LOSS GETS THE RECEIPT THE WRITE-OFF NOW WRITES.
--
-- Until now «أغلق كخسارة» (POST /api/ops/tracking/write-off) left the order
-- RETURNED with no return receipt. Everything that reads «a return nobody has
-- received» kept it: the desk's list, the daily alert, «شغلك اليوم», the
-- finance count of what is pending, and the media buyer (returned, with
-- returned_at empty). The door now closes the order the way the desk closes a
-- zero count; this file does the same for the write-offs already on record.
--
-- WHAT IT WRITES, per written-off order that has no receipt:
--   · a receipt: expected = what was expected back (the same sum the desk
--     uses), received 0, damaged 0, missing = expected, no courier fee, the
--     note «أُغلق كخسارة — لم يصل», counted by the person who wrote it off, on
--     the day they did.  An order whose expected-back is 0, or whose write-off
--     has no person on record, is left alone: a receipt with missing 0 would
--     read as a return that came back, and inspectedById cannot be empty.
--   · returnedAt, ONLY where it is empty, from the same day.
--   · settlementStatus = NOT_APPLICABLE, ONLY where no money is recorded
--     against the order (never SETTLED / COLLECTED / PARTIALLY_SETTLED /
--     REFUNDED / PARTIALLY_REFUNDED).
--
-- ADDITIVE AND SAFE TO RUN TWICE. Nothing is deleted. The receipt insert steps
-- aside for an order that already has one (return_receipts.orderId is unique);
-- the two updates only fill a blank or move an unrecorded settlement, and look
-- only at orders whose receipt THIS file wrote (ids starting with
-- 'wo-backfill-'), so a second run finds nothing left to do. Stock is not
-- touched: the write-off consumed it the day it happened. updatedAt and
-- version are not bumped, so no age-based alert is reset by it.
--
-- WHO RUNS IT, AND WHEN: the owner. It writes to the production database, so it
-- is applied on his word — `prisma db execute --file migration.sql` and then
-- `prisma migrate resolve --applied 20261029010000_write_off_closes_with_a_receipt`
-- — or by the container's `prisma migrate deploy` on the Redeploy he presses.
--
-- HOW MANY ORDERS IT WILL TOUCH (read-only; run it first):
--   SELECT count(*) AS will_get_a_receipt
--   FROM "orders" o
--   JOIN LATERAL (SELECT x."userId" FROM "order_activities" x
--                 WHERE x."orderId" = o."id" AND x."action" = 'WRITTEN_OFF_AS_LOSS'
--                 ORDER BY x."createdAt" ASC LIMIT 1) a ON true
--   WHERE o."shippingStatus" = 'RETURNED'
--     AND a."userId" IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM "return_receipts" r WHERE r."orderId" = o."id")
--     AND (SELECT COALESCE(SUM(GREATEST(0, i."quantity" + i."freeQuantity" - COALESCE(i."deliveredQty", 0))), 0)
--          FROM "order_items" i WHERE i."orderId" = o."id") > 0;
--   and, to see the ones it will skip:
--   SELECT count(*) AS left_alone
--   FROM "orders" o
--   WHERE o."shippingStatus" = 'RETURNED'
--     AND EXISTS (SELECT 1 FROM "order_activities" x WHERE x."orderId" = o."id" AND x."action" = 'WRITTEN_OFF_AS_LOSS')
--     AND NOT EXISTS (SELECT 1 FROM "return_receipts" r WHERE r."orderId" = o."id")
--     AND NOT (
--       (SELECT x."userId" FROM "order_activities" x WHERE x."orderId" = o."id" AND x."action" = 'WRITTEN_OFF_AS_LOSS'
--        ORDER BY x."createdAt" ASC LIMIT 1) IS NOT NULL
--       AND (SELECT COALESCE(SUM(GREATEST(0, i."quantity" + i."freeQuantity" - COALESCE(i."deliveredQty", 0))), 0)
--            FROM "order_items" i WHERE i."orderId" = o."id") > 0);

-- 1. The receipt, for each written-off order that has none.
INSERT INTO "return_receipts" (
  "id", "companyId", "orderId", "expectedQty", "receivedQty", "damagedQty", "missingQty",
  "courierFeeCharged", "courierFeeAmount", "inspectedById", "inspectedAt", "note", "stockRestored", "createdAt"
)
SELECT
  'wo-backfill-' || gen_random_uuid()::text, w."companyId", w."orderId", w."expectedQty", 0, 0, w."expectedQty",
  false, 0, w."userId", w."at", 'أُغلق كخسارة — لم يصل', false, now()
FROM (
  SELECT
    o."companyId" AS "companyId",
    o."id" AS "orderId",
    a."userId" AS "userId",
    a."createdAt" AS "at",
    (SELECT COALESCE(SUM(GREATEST(0, i."quantity" + i."freeQuantity" - COALESCE(i."deliveredQty", 0))), 0)
       FROM "order_items" i WHERE i."orderId" = o."id")::int AS "expectedQty"
  FROM "orders" o
  JOIN LATERAL (
    SELECT x."userId", x."createdAt" FROM "order_activities" x
    WHERE x."orderId" = o."id" AND x."action" = 'WRITTEN_OFF_AS_LOSS'
    ORDER BY x."createdAt" ASC LIMIT 1
  ) a ON true
  WHERE o."shippingStatus" = 'RETURNED'
    AND a."userId" IS NOT NULL
) w
WHERE w."expectedQty" > 0
ON CONFLICT ("orderId") DO NOTHING;

-- 2. The moment it was closed, where nobody had written one.
UPDATE "orders" o
SET "returnedAt" = r."inspectedAt"
FROM "return_receipts" r
WHERE r."orderId" = o."id"
  AND r."id" LIKE 'wo-backfill-%'
  AND r."receivedQty" = 0 AND r."damagedQty" = 0
  AND o."returnedAt" IS NULL;

-- 3. No settlement is owed on goods that never came back — unless money is already recorded.
UPDATE "orders" o
SET "settlementStatus" = 'NOT_APPLICABLE'
FROM "return_receipts" r
WHERE r."orderId" = o."id"
  AND r."id" LIKE 'wo-backfill-%'
  AND r."receivedQty" = 0 AND r."damagedQty" = 0
  AND o."settlementStatus" NOT IN ('NOT_APPLICABLE', 'SETTLED', 'COLLECTED', 'PARTIALLY_SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED');
