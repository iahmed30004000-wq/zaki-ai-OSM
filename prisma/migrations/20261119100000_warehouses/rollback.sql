-- Rollback of 20261119100000_warehouses.
-- Run ONLY after the previous release is redeployed: this release's Prisma client selects these columns.
-- In this release nothing but the warehouses screen writes here, so rolling back loses the warehouses the owner
-- typed and their keepers; once a later request has placed stock, it loses every batch's place as well — do not
-- roll back past that point without a count.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_sourceWarehouseId_fkey";
DROP INDEX IF EXISTS "orders_sourceWarehouseId_idx";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "sourceWarehouseId";

ALTER TABLE "shipping_batches" DROP CONSTRAINT IF EXISTS "shipping_batches_warehouseId_fkey";
DROP INDEX IF EXISTS "shipping_batches_warehouseId_idx";
ALTER TABLE "shipping_batches" DROP COLUMN IF EXISTS "warehouseId";

ALTER TABLE "inventory_movements" DROP CONSTRAINT IF EXISTS "inventory_movements_warehouse_id_fkey";
DROP INDEX IF EXISTS "inventory_movements_companyId_warehouse_id_createdAt_idx";
ALTER TABLE "inventory_movements" DROP COLUMN IF EXISTS "warehouse_id";

ALTER TABLE "production_batches" DROP CONSTRAINT IF EXISTS "production_batches_split_from_batch_id_fkey";
ALTER TABLE "production_batches" DROP CONSTRAINT IF EXISTS "production_batches_warehouse_id_fkey";
DROP INDEX IF EXISTS "production_batches_split_from_batch_id_idx";
DROP INDEX IF EXISTS "production_batches_companyId_productId_warehouse_id_idx";
ALTER TABLE "production_batches" DROP COLUMN IF EXISTS "in_transit_transfer_id";
ALTER TABLE "production_batches" DROP COLUMN IF EXISTS "split_from_batch_id";
ALTER TABLE "production_batches" DROP COLUMN IF EXISTS "quantity_moved_out";
ALTER TABLE "production_batches" DROP COLUMN IF EXISTS "quantity_moved_in";
ALTER TABLE "production_batches" DROP COLUMN IF EXISTS "warehouse_id";

DROP TABLE IF EXISTS "user_warehouse_access";
DROP TABLE IF EXISTS "warehouses";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119100000_warehouses';
