-- Rollback for scripts/backfills/20261029-write-offs-close-with-a-receipt.sql (run by the owner, the same way).
-- Removes only the receipts that script wrote (ids starting with 'wo-backfill-'),
-- and puts returnedAt back to empty only where it still holds that receipt's day.
-- A receipt the desk wrote or completed since then has another id and stays.
-- A parcel that turned up and was completed at the desk had its receipt rewritten
-- in place (same id): after that the receipt holds real units, and it is NOT removed.
-- settlementStatus is not put back: NOT_APPLICABLE on a lost parcel is true either way.
UPDATE "orders" o
SET "returnedAt" = NULL
FROM "return_receipts" r
WHERE r."orderId" = o."id"
  AND r."id" LIKE 'wo-backfill-%'
  AND r."receivedQty" = 0 AND r."damagedQty" = 0
  AND o."returnedAt" = r."inspectedAt";
DELETE FROM "return_receipts"
WHERE "id" LIKE 'wo-backfill-%' AND "receivedQty" = 0 AND "damagedQty" = 0;
