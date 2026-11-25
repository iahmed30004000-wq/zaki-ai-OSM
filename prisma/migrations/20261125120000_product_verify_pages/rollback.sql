-- Rollback for 20261125120000_product_verify_pages. Run ONLY after the previous release is redeployed
-- (i.e. after the code that reads/writes "product_verify_pages" is no longer live) — otherwise the running
-- app errors on every public /verify/p/<id> page and on «باركود المنتجات».
-- Every printed product barcode stops opening a page once this runs; the per-piece codes in
-- "authenticity_codes" are untouched and still check on the store-level /verify/<storeId>.

DROP TABLE IF EXISTS "product_verify_page_slugs";
DROP TABLE IF EXISTS "product_verify_pages";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261125120000_product_verify_pages';
