-- Rollback of 20261120160000_product_pairs. Idempotent: running it twice is the same as running it once.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows this table.
-- Nothing else reads the table in this release, so only the saved pairs are lost (which product of one store is the
-- same goods as which product of another, and who said so). No stock, batch, movement or money row is touched.
ALTER TABLE IF EXISTS "product_pairs" DROP CONSTRAINT IF EXISTS "product_pairs_productBId_fkey";
ALTER TABLE IF EXISTS "product_pairs" DROP CONSTRAINT IF EXISTS "product_pairs_productAId_fkey";
ALTER TABLE IF EXISTS "product_pairs" DROP CONSTRAINT IF EXISTS "product_pairs_companyId_fkey";
DROP TABLE IF EXISTS "product_pairs";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120160000_product_pairs';
