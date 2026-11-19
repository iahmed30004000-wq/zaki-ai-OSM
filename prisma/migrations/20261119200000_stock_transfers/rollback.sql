-- Rollback of 20261119200000_stock_transfers. Idempotent: running it twice is the same as running it once.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows these tables.
-- Once a transfer has been sent, its in-transit batch rows hold units on the road with no warehouse: dropping the table
-- leaves them with an id that points nowhere and no document that says where they were going. Do not roll back past a
-- first transfer without receiving or cancelling every open one first (the batches keep their units either way — no
-- quantity is lost by this file; only the documents are).
ALTER TABLE IF EXISTS "production_batches" DROP CONSTRAINT IF EXISTS "production_batches_in_transit_transfer_id_fkey";
DROP INDEX IF EXISTS "production_batches_in_transit_transfer_id_idx";

ALTER TABLE IF EXISTS "stock_transfer_lines" DROP CONSTRAINT IF EXISTS "stock_transfer_lines_productId_fkey";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP CONSTRAINT IF EXISTS "stock_transfer_lines_transferId_fkey";
DROP TABLE IF EXISTS "stock_transfer_lines";

ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_toWarehouseId_fkey";
ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_fromWarehouseId_fkey";
ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_storeId_fkey";
ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_companyId_fkey";
DROP TABLE IF EXISTS "stock_transfers";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119200000_stock_transfers';
