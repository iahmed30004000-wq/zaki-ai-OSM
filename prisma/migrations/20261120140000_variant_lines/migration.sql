-- Combinations in the stock documents (warehouse plan, request W8b). A transfer line and an exit line of a product that
-- has combinations (size/colour) carry them; the product line's quantity is the sum of its combinations. A combination
-- moved between warehouses moves its places through the one writer (`src/lib/variant-stock.ts`), and its pieces on the
-- road live in a road row, exactly as a batch twin on the road does.
--
-- ADDITIVE. Nothing is dropped that holds data, and NO ROW IS WRITTEN or rewritten:
--
--   stock_transfer_line_variants   lineId, transferId, productId, variantId, quantitySent, quantityReceived
--                                  one row per (line, combination); CHECK sent > 0, 0 ≤ received ≤ sent
--   stock_exit_line_variants       lineId, exitId, productId, variantId, quantity
--                                  one row per (line, combination); CHECK quantity > 0
--   product_variant_stock          + "inTransitTransferId" (NULL)  → stock_transfers (NO ACTION, like the batches')
--   variant_stock_movements        + "inTransitTransferId" (NULL), + "referenceId" (NULL)
--
-- ONE INDEX IS NARROWED, not dropped: `product_variant_stock_one_unplaced` (one «بلا مكان» row per combination) said
-- WHERE "warehouseId" IS NULL; a road row has no warehouse either, so it now says WHERE "warehouseId" IS NULL AND
-- "inTransitTransferId" IS NULL. Every row allowed before is allowed now (no road row exists before this migration), and
-- `product_variant_stock_one_road` holds one road row per (combination, transfer). A partial index cannot be altered,
-- only replaced: dropped and created again under the same name, in this file's order (as `20261029120000` did).
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261120140000_variant_lines/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261120140000_variant_lines
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "stock_transfer_line_variants" (
  "id"               TEXT    NOT NULL,
  "lineId"           TEXT    NOT NULL,
  "transferId"       TEXT    NOT NULL,
  "productId"        TEXT    NOT NULL,
  "variantId"        TEXT    NOT NULL,
  "quantitySent"     INTEGER NOT NULL,
  "quantityReceived" INTEGER,
  CONSTRAINT "stock_transfer_line_variants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "stock_transfer_line_variants_lineId_variantId_key" ON "stock_transfer_line_variants" ("lineId", "variantId");
CREATE INDEX IF NOT EXISTS "stock_transfer_line_variants_transferId_idx" ON "stock_transfer_line_variants" ("transferId");
CREATE INDEX IF NOT EXISTS "stock_transfer_line_variants_variantId_idx" ON "stock_transfer_line_variants" ("variantId");
DO $$ BEGIN
  ALTER TABLE "stock_transfer_line_variants" ADD CONSTRAINT "stock_transfer_line_variants_quantity_check"
    CHECK ("quantitySent" > 0 AND ("quantityReceived" IS NULL OR ("quantityReceived" >= 0 AND "quantityReceived" <= "quantitySent")));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfer_line_variants" ADD CONSTRAINT "stock_transfer_line_variants_lineId_fkey"
    FOREIGN KEY ("lineId") REFERENCES "stock_transfer_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfer_line_variants" ADD CONSTRAINT "stock_transfer_line_variants_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "stock_exit_line_variants" (
  "id"        TEXT    NOT NULL,
  "lineId"    TEXT    NOT NULL,
  "exitId"    TEXT    NOT NULL,
  "productId" TEXT    NOT NULL,
  "variantId" TEXT    NOT NULL,
  "quantity"  INTEGER NOT NULL,
  CONSTRAINT "stock_exit_line_variants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "stock_exit_line_variants_lineId_variantId_key" ON "stock_exit_line_variants" ("lineId", "variantId");
CREATE INDEX IF NOT EXISTS "stock_exit_line_variants_exitId_idx" ON "stock_exit_line_variants" ("exitId");
CREATE INDEX IF NOT EXISTS "stock_exit_line_variants_variantId_idx" ON "stock_exit_line_variants" ("variantId");
DO $$ BEGIN
  ALTER TABLE "stock_exit_line_variants" ADD CONSTRAINT "stock_exit_line_variants_quantity_check" CHECK ("quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exit_line_variants" ADD CONSTRAINT "stock_exit_line_variants_lineId_fkey"
    FOREIGN KEY ("lineId") REFERENCES "stock_exit_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exit_line_variants" ADD CONSTRAINT "stock_exit_line_variants_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "product_variant_stock" ADD COLUMN IF NOT EXISTS "inTransitTransferId" TEXT;
CREATE INDEX IF NOT EXISTS "product_variant_stock_inTransitTransferId_idx" ON "product_variant_stock" ("inTransitTransferId");
DO $$ BEGIN
  ALTER TABLE "product_variant_stock" ADD CONSTRAINT "product_variant_stock_inTransitTransferId_fkey"
    FOREIGN KEY ("inTransitTransferId") REFERENCES "stock_transfers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The «بلا مكان» rule, narrowed (see the head of this file), and the road's own rule.
DROP INDEX IF EXISTS "product_variant_stock_one_unplaced";
CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_stock_one_unplaced" ON "product_variant_stock" ("variantId")
  WHERE "warehouseId" IS NULL AND "inTransitTransferId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_stock_one_road" ON "product_variant_stock" ("variantId", "inTransitTransferId")
  WHERE "inTransitTransferId" IS NOT NULL;

ALTER TABLE "variant_stock_movements" ADD COLUMN IF NOT EXISTS "inTransitTransferId" TEXT;
ALTER TABLE "variant_stock_movements" ADD COLUMN IF NOT EXISTS "referenceId" TEXT;
