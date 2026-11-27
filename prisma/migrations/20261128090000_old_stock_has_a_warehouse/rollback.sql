-- Rollback: redeploy the old release, THEN run this file.
-- It forgets which warehouse the old stock was given; the units and the order stamps stay where the press put them.
ALTER TABLE "warehouse_placements" DROP COLUMN IF EXISTS "oldStockWarehouseId";
ALTER TABLE "warehouse_placements" DROP COLUMN IF EXISTS "oldStockMovedAt";
