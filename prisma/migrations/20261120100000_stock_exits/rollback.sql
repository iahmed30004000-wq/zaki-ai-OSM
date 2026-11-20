-- Rollback of 20261120100000_stock_exits. Idempotent: running it twice is the same as running it once.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows these tables.
-- The batches and the ledger are not touched by this file: an approved exit already took its units off the shelf and
-- wrote its movement lines (they stay, with the exit's id in `referenceId`); a pending exit only held units, and with
-- its table gone the hold is gone too. Only the documents are lost — their reasons, who asked, who approved, and the
-- value at cost of each line.
ALTER TABLE IF EXISTS "stock_exit_lines" DROP CONSTRAINT IF EXISTS "stock_exit_lines_productId_fkey";
ALTER TABLE IF EXISTS "stock_exit_lines" DROP CONSTRAINT IF EXISTS "stock_exit_lines_exitId_fkey";
DROP TABLE IF EXISTS "stock_exit_lines";

ALTER TABLE IF EXISTS "stock_exits" DROP CONSTRAINT IF EXISTS "stock_exits_warehouseId_fkey";
ALTER TABLE IF EXISTS "stock_exits" DROP CONSTRAINT IF EXISTS "stock_exits_storeId_fkey";
ALTER TABLE IF EXISTS "stock_exits" DROP CONSTRAINT IF EXISTS "stock_exits_companyId_fkey";
DROP TABLE IF EXISTS "stock_exits";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120100000_stock_exits';
