-- A combination's count per warehouse (warehouse plan, request W8a). For a store that is PLACED in warehouses, a
-- product variant's count lives per place and `product_variants."onHand"` is their sum, written by one function
-- (`src/lib/variant-stock.ts`); every change writes a ledger line. A store that is not placed never reads or writes here.
--
-- ADDITIVE ONLY. Two new, empty tables, their indexes and foreign keys. Nothing is altered, dropped or backfilled, and
-- NO ROW IS WRITTEN: a combination of a placed store gets its rows the first time its count changes (the count it had
-- then becomes its «بلا مكان» row, with an OPENING ledger line).
--
--   product_variant_stock     companyId, variantId, warehouseId (NULL = «بلا مكان»), onHand
--                             one row per (combination, warehouse) and ONE «بلا مكان» row per combination — the partial
--                             unique index product_variant_stock_one_unplaced (named in schema.prisma)
--   variant_stock_movements   companyId, storeId, productId, variantId, warehouseId, type, quantity (signed),
--                             placeAfter, onHandAfter, reason, orderId, createdById, createdAt
--
-- Warehouse foreign keys are NO ACTION, like the batches': a warehouse is stopped, never deleted.
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261119210000_variant_stock/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261119210000_variant_stock
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "product_variant_stock" (
  "id"          TEXT         NOT NULL,
  "companyId"   TEXT         NOT NULL,
  "variantId"   TEXT         NOT NULL,
  "warehouseId" TEXT,
  "onHand"      INTEGER      NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_variant_stock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_stock_variantId_warehouseId_key" ON "product_variant_stock" ("variantId", "warehouseId");
-- Postgres counts every NULL as distinct, so the pair above lets two «بلا مكان» rows through. This one does not.
CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_stock_one_unplaced" ON "product_variant_stock" ("variantId") WHERE "warehouseId" IS NULL;
CREATE INDEX IF NOT EXISTS "product_variant_stock_companyId_warehouseId_idx" ON "product_variant_stock" ("companyId", "warehouseId");
DO $$ BEGIN
  ALTER TABLE "product_variant_stock" ADD CONSTRAINT "product_variant_stock_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_variant_stock" ADD CONSTRAINT "product_variant_stock_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "variant_stock_movements" (
  "id"          TEXT         NOT NULL,
  "companyId"   TEXT         NOT NULL,
  "storeId"     TEXT,
  "productId"   TEXT         NOT NULL,
  "variantId"   TEXT         NOT NULL,
  "warehouseId" TEXT,
  "type"        TEXT         NOT NULL,
  "quantity"    INTEGER      NOT NULL,
  "placeAfter"  INTEGER      NOT NULL,
  "onHandAfter" INTEGER      NOT NULL,
  "reason"      TEXT,
  "orderId"     TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "variant_stock_movements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "variant_stock_movements_companyId_variantId_createdAt_idx" ON "variant_stock_movements" ("companyId", "variantId", "createdAt");
CREATE INDEX IF NOT EXISTS "variant_stock_movements_companyId_warehouseId_createdAt_idx" ON "variant_stock_movements" ("companyId", "warehouseId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "variant_stock_movements_companyId_storeId_createdAt_idx" ON "variant_stock_movements" ("companyId", "storeId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "variant_stock_movements" ADD CONSTRAINT "variant_stock_movements_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "variant_stock_movements" ADD CONSTRAINT "variant_stock_movements_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
