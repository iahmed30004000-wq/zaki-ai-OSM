-- Rollback of 20261121100000_stock_counts. Idempotent: running it twice is the same as running it once.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows these tables.
-- The batches and the ledger are not touched by this file: an approved sheet already applied its differences and wrote
-- its movement lines (they stay, with the sheet's id in `referenceId`); an open sheet only froze its warehouse, and with
-- its table gone the freeze is gone too. Only the documents are lost — who counted, what was counted, the frozen
-- expected figures and who approved.
ALTER TABLE IF EXISTS "stock_count_line_variants" DROP CONSTRAINT IF EXISTS "stock_count_line_variants_variantId_fkey";
ALTER TABLE IF EXISTS "stock_count_line_variants" DROP CONSTRAINT IF EXISTS "stock_count_line_variants_lineId_fkey";
DROP TABLE IF EXISTS "stock_count_line_variants";

ALTER TABLE IF EXISTS "stock_count_lines" DROP CONSTRAINT IF EXISTS "stock_count_lines_productId_fkey";
ALTER TABLE IF EXISTS "stock_count_lines" DROP CONSTRAINT IF EXISTS "stock_count_lines_countId_fkey";
DROP TABLE IF EXISTS "stock_count_lines";

ALTER TABLE IF EXISTS "stock_counts" DROP CONSTRAINT IF EXISTS "stock_counts_warehouseId_fkey";
ALTER TABLE IF EXISTS "stock_counts" DROP CONSTRAINT IF EXISTS "stock_counts_storeId_fkey";
ALTER TABLE IF EXISTS "stock_counts" DROP CONSTRAINT IF EXISTS "stock_counts_companyId_fkey";
DROP TABLE IF EXISTS "stock_counts";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121100000_stock_counts';
