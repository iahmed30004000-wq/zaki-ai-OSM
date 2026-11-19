-- Rollback of 20261119140000_warehouse_placements.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows this table.
-- Dropping it makes every placed store «not placed» again while its batches keep their warehouse — so once a store has
-- been placed, do not roll back without a count: the places would remain with no record of the placement that made them.
ALTER TABLE IF EXISTS "warehouse_placements" DROP CONSTRAINT IF EXISTS "warehouse_placements_storeId_fkey";
DROP INDEX IF EXISTS "warehouse_placements_companyId_countedAt_idx";
DROP INDEX IF EXISTS "warehouse_placements_storeId_key";
DROP TABLE IF EXISTS "warehouse_placements";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119140000_warehouse_placements';
