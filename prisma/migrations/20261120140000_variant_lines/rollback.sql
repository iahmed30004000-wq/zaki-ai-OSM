-- Rollback of 20261120140000_variant_lines. Idempotent: running it twice is the same as running it once.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows these tables and columns.
--
-- It REFUSES (and changes nothing) while a combination's pieces are on a transfer's road: the previous release has no
-- place for them, and dropping the column would lose where they are. Receive or cancel those transfers first.
-- Otherwise: the combination lines of transfers and exits are lost (the product lines and their quantities stay), the
-- ledger lines lose which document and which road they named (their places and quantities stay), and the «بلا مكان»
-- rule goes back to its first wording.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variant_stock' AND column_name = 'inTransitTransferId') THEN
    IF EXISTS (SELECT 1 FROM "product_variant_stock" WHERE "inTransitTransferId" IS NOT NULL AND "onHand" <> 0) THEN
      RAISE EXCEPTION 'rollback refused: combination pieces are on a transfer road (receive or cancel those transfers first)';
    END IF;
    -- Empty road rows (received, cancelled or approved) hold nothing; without the column they would be «بلا مكان» twins.
    DELETE FROM "product_variant_stock" WHERE "inTransitTransferId" IS NOT NULL;
  END IF;
END $$;

DROP INDEX IF EXISTS "product_variant_stock_one_road";
DROP INDEX IF EXISTS "product_variant_stock_one_unplaced";
CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_stock_one_unplaced" ON "product_variant_stock" ("variantId") WHERE "warehouseId" IS NULL;
ALTER TABLE IF EXISTS "product_variant_stock" DROP CONSTRAINT IF EXISTS "product_variant_stock_inTransitTransferId_fkey";
DROP INDEX IF EXISTS "product_variant_stock_inTransitTransferId_idx";
ALTER TABLE IF EXISTS "product_variant_stock" DROP COLUMN IF EXISTS "inTransitTransferId";

ALTER TABLE IF EXISTS "variant_stock_movements" DROP COLUMN IF EXISTS "inTransitTransferId";
ALTER TABLE IF EXISTS "variant_stock_movements" DROP COLUMN IF EXISTS "referenceId";

ALTER TABLE IF EXISTS "stock_exit_line_variants" DROP CONSTRAINT IF EXISTS "stock_exit_line_variants_variantId_fkey";
ALTER TABLE IF EXISTS "stock_exit_line_variants" DROP CONSTRAINT IF EXISTS "stock_exit_line_variants_lineId_fkey";
DROP TABLE IF EXISTS "stock_exit_line_variants";

ALTER TABLE IF EXISTS "stock_transfer_line_variants" DROP CONSTRAINT IF EXISTS "stock_transfer_line_variants_variantId_fkey";
ALTER TABLE IF EXISTS "stock_transfer_line_variants" DROP CONSTRAINT IF EXISTS "stock_transfer_line_variants_lineId_fkey";
DROP TABLE IF EXISTS "stock_transfer_line_variants";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120140000_variant_lines';
