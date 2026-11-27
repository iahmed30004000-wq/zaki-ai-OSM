-- Additive only: two nullable columns on warehouse_placements. No row is rewritten.
--
-- 27/11: the warehouse the old stock belongs to, written once by the press on the balances screen
-- (src/lib/old-stock-home.ts). NULL = not pressed: every door behaves as before.
ALTER TABLE "warehouse_placements" ADD COLUMN IF NOT EXISTS "oldStockWarehouseId" TEXT;
ALTER TABLE "warehouse_placements" ADD COLUMN IF NOT EXISTS "oldStockMovedAt" TIMESTAMP(3);
