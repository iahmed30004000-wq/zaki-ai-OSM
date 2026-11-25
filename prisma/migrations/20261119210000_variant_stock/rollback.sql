-- Rollback of 20261119210000_variant_stock.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows these tables.
-- Dropping them returns every combination to its single store-level count. `product_variants."onHand"` stays what it is
-- (it is always the sum of the dropped rows), so nothing on the shelf changes; only WHERE each piece is, and the history
-- of those changes, is lost — once a placed store has counted its combinations per warehouse, do not roll back without
-- writing the per-warehouse counts down first.
-- Idempotent: safe to run twice.
ALTER TABLE IF EXISTS "variant_stock_movements" DROP CONSTRAINT IF EXISTS "variant_stock_movements_warehouseId_fkey";
ALTER TABLE IF EXISTS "variant_stock_movements" DROP CONSTRAINT IF EXISTS "variant_stock_movements_variantId_fkey";
DROP INDEX IF EXISTS "variant_stock_movements_companyId_storeId_createdAt_idx";
DROP INDEX IF EXISTS "variant_stock_movements_companyId_warehouseId_createdAt_idx";
DROP INDEX IF EXISTS "variant_stock_movements_companyId_variantId_createdAt_idx";
DROP TABLE IF EXISTS "variant_stock_movements";

ALTER TABLE IF EXISTS "product_variant_stock" DROP CONSTRAINT IF EXISTS "product_variant_stock_warehouseId_fkey";
ALTER TABLE IF EXISTS "product_variant_stock" DROP CONSTRAINT IF EXISTS "product_variant_stock_variantId_fkey";
DROP INDEX IF EXISTS "product_variant_stock_companyId_warehouseId_idx";
DROP INDEX IF EXISTS "product_variant_stock_one_unplaced";
DROP INDEX IF EXISTS "product_variant_stock_variantId_warehouseId_key";
DROP TABLE IF EXISTS "product_variant_stock";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119210000_variant_stock';
