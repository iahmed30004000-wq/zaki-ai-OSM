-- The same article in two stores (warehouse plan, request W7a): two products of two stores of ONE company that a person
-- said are the same goods. Nothing reads this table yet; the transfer between stores (W7b) will read it to know where
-- the goods land.
--
-- ADDITIVE ONLY. One new, empty table with its indexes, CHECKs and foreign keys. Nothing existing is altered, dropped or
-- backfilled, and NO ROW IS WRITTEN.
--
--   product_pairs   companyId, productAId + storeAId, productBId + storeBId, hint (why it was proposed), who saved it
--                   and when
--
-- One row per unordered couple, written in ONE direction: side A is the store whose id sorts first (COLLATE "C", the
-- byte order JavaScript's `<` gives for these ids). So a product is on the same side of every pair it has with a given
-- store, and the database itself holds:
--   * one pair per couple                          product_pairs_productAId_productBId_key
--   * one twin per product per other store         product_pairs_productAId_storeBId_key + product_pairs_productBId_storeAId_key
--   * two different stores                         product_pairs_store_order_check (A < B, so never equal)
-- The CHECKs are named in `schema.prisma` above the model (Prisma cannot express them).
--
-- Foreign keys: the company and each product CASCADE (a pair goes with either of its products). No key to `stores`:
-- the store columns are copies of the products' stores, and a store with products cannot be deleted
-- (`products.store_id` RESTRICT). No money: no wallet, expense or profit table is named here.
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261120160000_product_pairs/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261120160000_product_pairs
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "product_pairs" (
  "id"          TEXT         NOT NULL,
  "companyId"   TEXT         NOT NULL,
  "productAId"  TEXT         NOT NULL,
  "storeAId"    TEXT         NOT NULL,
  "productBId"  TEXT         NOT NULL,
  "storeBId"    TEXT         NOT NULL,
  "hint"        TEXT,
  "createdById" TEXT         NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_pairs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_pairs_productAId_productBId_key" ON "product_pairs" ("productAId", "productBId");
CREATE UNIQUE INDEX IF NOT EXISTS "product_pairs_productAId_storeBId_key" ON "product_pairs" ("productAId", "storeBId");
CREATE UNIQUE INDEX IF NOT EXISTS "product_pairs_productBId_storeAId_key" ON "product_pairs" ("productBId", "storeAId");
CREATE INDEX IF NOT EXISTS "product_pairs_companyId_storeAId_idx" ON "product_pairs" ("companyId", "storeAId");
CREATE INDEX IF NOT EXISTS "product_pairs_companyId_storeBId_idx" ON "product_pairs" ("companyId", "storeBId");
DO $$ BEGIN
  ALTER TABLE "product_pairs" ADD CONSTRAINT "product_pairs_store_order_check"
    CHECK ("storeAId" COLLATE "C" < "storeBId" COLLATE "C");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_pairs" ADD CONSTRAINT "product_pairs_hint_check"
    CHECK ("hint" IS NULL OR "hint" IN ('SKU', 'NAME', 'NAME_EN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_pairs" ADD CONSTRAINT "product_pairs_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_pairs" ADD CONSTRAINT "product_pairs_productAId_fkey"
    FOREIGN KEY ("productAId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_pairs" ADD CONSTRAINT "product_pairs_productBId_fkey"
    FOREIGN KEY ("productBId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
