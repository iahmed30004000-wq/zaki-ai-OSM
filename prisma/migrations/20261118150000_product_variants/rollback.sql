-- Rollback of 20261118150000_product_variants.
-- Run ONLY after the previous release is redeployed: this release reads these columns and tables on every product
-- page and every order. Rolling back loses every product's option types, its combinations and the per-piece record
-- of orders taken with variants (the orders themselves, their lines and their money stay).
DROP TABLE IF EXISTS "order_item_variants";
DROP TABLE IF EXISTS "product_variants";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "variantSummary";
ALTER TABLE "products" DROP COLUMN IF EXISTS "variantOptions";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118150000_product_variants';
