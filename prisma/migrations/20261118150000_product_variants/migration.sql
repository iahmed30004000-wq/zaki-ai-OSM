-- Product variants (the owner's decision, 2026-11-18): a product may have option types (size, colour) and each
-- sellable combination has its own price delta and its own stock; an order line records each piece's combination.
-- ADDITIVE ONLY: two nullable columns and two new, empty tables. Nothing is altered, dropped or backfilled; a product
-- whose "variantOptions" is NULL (every existing product) is sold exactly as before.
--
--   products."variantOptions"       TEXT NULL   (JSON: the option types and their values)
--   order_items."variantSummary"    TEXT NULL   (snapshot label of the line's pieces)
--   product_variants                one row per sellable combination
--   order_item_variants             the pieces of one order line, by combination
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261118150000_product_variants/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261118150000_product_variants
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "variantOptions" TEXT;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variantSummary" TEXT;

CREATE TABLE IF NOT EXISTS "product_variants" (
  "id"           TEXT             NOT NULL,
  "companyId"    TEXT             NOT NULL,
  "productId"    TEXT             NOT NULL,
  "optionValues" TEXT             NOT NULL,
  "label"        TEXT             NOT NULL,
  "sku"          TEXT,
  "priceDelta"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "onHand"       INTEGER          NOT NULL DEFAULT 0,
  "status"       TEXT             NOT NULL DEFAULT 'ACTIVE',
  "sortOrder"    INTEGER          NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)     NOT NULL,
  CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "product_variants_companyId_productId_idx" ON "product_variants" ("companyId", "productId");
DO $$ BEGIN
  ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "order_item_variants" (
  "id"           TEXT             NOT NULL,
  "companyId"    TEXT             NOT NULL,
  "orderId"      TEXT             NOT NULL,
  "orderItemId"  TEXT             NOT NULL,
  "productId"    TEXT             NOT NULL,
  "variantId"    TEXT,
  "label"        TEXT             NOT NULL,
  "quantity"     INTEGER          NOT NULL DEFAULT 0,
  "freeQuantity" INTEGER          NOT NULL DEFAULT 0,
  "priceDelta"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_item_variants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "order_item_variants_orderItemId_idx" ON "order_item_variants" ("orderItemId");
CREATE INDEX IF NOT EXISTS "order_item_variants_orderId_idx" ON "order_item_variants" ("orderId");
CREATE INDEX IF NOT EXISTS "order_item_variants_companyId_variantId_idx" ON "order_item_variants" ("companyId", "variantId");
DO $$ BEGIN
  ALTER TABLE "order_item_variants" ADD CONSTRAINT "order_item_variants_orderItemId_fkey"
    FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "order_item_variants" ADD CONSTRAINT "order_item_variants_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
