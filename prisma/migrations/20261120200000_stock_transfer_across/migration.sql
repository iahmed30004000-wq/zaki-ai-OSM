-- Stock transfers ACROSS stores and countries (warehouse plan, request W7b): the same document as W3a, now with a
-- destination store, the owner's approval press for another country, and the cost the goods carry.
--
-- ADDITIVE ONLY. Nullable columns on the two existing tables, one index, two new CHECKs, two foreign keys, and ONE
-- check WIDENED (the status words gain AWAITING_APPROVAL; every row already there keeps a word the new check accepts).
-- Nothing is dropped from data, nothing is backfilled, and NO ROW IS WRITTEN.
--
--   stock_transfers       "toStoreId"    whose goods ARRIVE (null = the source store, INTERNAL — every existing row)
--                         "approvedById", "approvedAt"   the owner's press on a transfer to another country
--   stock_transfer_lines  "toProductId"  the twin the units land in (from product_pairs, kept at the send)
--                         "costOut"      what the units that left cost (the draw-down's own figure, not rounded)
--                         "landedCosts"  the cost lines typed at receipt (JSON: kind, amount, note)
--                         "unitCostIn"   the destination's unit cost, rounded to its minor unit
--                         "costRemainder" what that rounding left out (booked nowhere; for the report)
--                         "zeroCostReason" why a unit cost of zero is real
--
-- CHECKs (named in `schema.prisma` above the models):
--   stock_transfers_status_check     REPLACED by the same list plus 'AWAITING_APPROVAL' (a check cannot be altered,
--                                    only dropped and added; both in one transaction of this file).
--   stock_transfers_to_store_check   "toStoreId" is null exactly for INTERNAL, and never the source store. Every
--                                    existing row is INTERNAL with a null "toStoreId", so it validates.
--   stock_transfer_lines_cost_check  "costOut" and "unitCostIn" null or ≥ 0.
-- Foreign keys: "toStoreId" → stores RESTRICT (like "storeId": a store with a transfer has a history);
--               "toProductId" → products SET NULL (the line stays when the twin is deleted; its own product's key
--               already takes the line with it — the backlog item on product deletion is not changed here).
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object /
-- DROP … IF EXISTS before the re-add). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261120200000_stock_transfer_across/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261120200000_stock_transfer_across
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "toStoreId"    TEXT;
ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "approvedById" TEXT;
ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "approvedAt"   TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "stock_transfers_companyId_toStoreId_createdAt_idx" ON "stock_transfers" ("companyId", "toStoreId", "createdAt" DESC);

ALTER TABLE "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_status_check";
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_status_check"
  CHECK ("status" IN ('AWAITING_APPROVAL', 'SENT', 'RECEIVED', 'RECEIVED_WITH_DIFFERENCE', 'CANCELLED'));

DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_store_check"
    CHECK ((("kind" = 'INTERNAL') = ("toStoreId" IS NULL)) AND ("toStoreId" IS NULL OR "toStoreId" <> "storeId"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_toStoreId_fkey"
    FOREIGN KEY ("toStoreId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "stock_transfer_lines" ADD COLUMN IF NOT EXISTS "toProductId"    TEXT;
ALTER TABLE "stock_transfer_lines" ADD COLUMN IF NOT EXISTS "costOut"        DOUBLE PRECISION;
ALTER TABLE "stock_transfer_lines" ADD COLUMN IF NOT EXISTS "landedCosts"    JSONB;
ALTER TABLE "stock_transfer_lines" ADD COLUMN IF NOT EXISTS "unitCostIn"     DOUBLE PRECISION;
ALTER TABLE "stock_transfer_lines" ADD COLUMN IF NOT EXISTS "costRemainder"  DOUBLE PRECISION;
ALTER TABLE "stock_transfer_lines" ADD COLUMN IF NOT EXISTS "zeroCostReason" TEXT;
CREATE INDEX IF NOT EXISTS "stock_transfer_lines_toProductId_idx" ON "stock_transfer_lines" ("toProductId");
DO $$ BEGIN
  ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_cost_check"
    CHECK (("costOut" IS NULL OR "costOut" >= 0) AND ("unitCostIn" IS NULL OR "unitCostIn" >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_toProductId_fkey"
    FOREIGN KEY ("toProductId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
