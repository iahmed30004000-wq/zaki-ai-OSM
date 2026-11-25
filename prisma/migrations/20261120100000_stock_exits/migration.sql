-- Stock exits (warehouse plan, request W6a): goods that leave a warehouse for good, not by a sale — a request with a
-- reason, held until a different person approves (oldest first in that warehouse) or rejects it.
--
-- ADDITIVE ONLY. Two new, empty tables with their indexes, CHECKs and foreign keys. Nothing existing is altered,
-- dropped or backfilled, and NO ROW IS WRITTEN.
--
--   stock_exits        companyId, storeId (whose goods), warehouseId, reason, note, status, who asked and when, who
--                      decided (approved or rejected) and when, the rejection's reason
--   stock_exit_lines   exitId, productId (one line per product), quantity, valueAtCost (null until approved: what the
--                      units that left cost at their batches' cost)
--
-- The CHECKs hold what Prisma cannot say (named in `schema.prisma` above the model): the seven reasons, the three
-- statuses, «أخرى» carries a sentence, a positive quantity and a value at cost that is null or not negative.
-- Foreign keys: the store RESTRICT (like `stock_transfers`: a store with an exit has a history — `geo-removal.ts` lists
-- the table); the warehouse NO ACTION (a warehouse is never deleted, only stopped); a line goes with its exit and with
-- its product (the product's batches and movements already go with it — a known item of the backlog, not changed here).
--
-- No money: no wallet, expense or profit table is named here or written by the exit door.
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261120100000_stock_exits/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261120100000_stock_exits
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "stock_exits" (
  "id"            TEXT         NOT NULL,
  "companyId"     TEXT         NOT NULL,
  "storeId"       TEXT         NOT NULL,
  "warehouseId"   TEXT         NOT NULL,
  "reason"        TEXT         NOT NULL,
  "note"          TEXT,
  "status"        TEXT         NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT         NOT NULL,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById"   TEXT,
  "decidedAt"     TIMESTAMP(3),
  "rejectReason"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_exits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stock_exits_companyId_storeId_createdAt_idx" ON "stock_exits" ("companyId", "storeId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "stock_exits_warehouseId_status_idx" ON "stock_exits" ("warehouseId", "status");
DO $$ BEGIN
  ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_reason_check"
    CHECK ("reason" IN ('DAMAGED', 'EXPIRED', 'SAMPLES', 'SUPPLIER_RETURN', 'OFF_SYSTEM_SALE', 'PARTNER_DRAW', 'OTHER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_status_check"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_other_needs_note_check"
    CHECK ("reason" <> 'OTHER' OR length(btrim(coalesce("note", ''))) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "stock_exit_lines" (
  "id"          TEXT             NOT NULL,
  "exitId"      TEXT             NOT NULL,
  "productId"   TEXT             NOT NULL,
  "quantity"    INTEGER          NOT NULL,
  "valueAtCost" DOUBLE PRECISION,
  CONSTRAINT "stock_exit_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "stock_exit_lines_exitId_productId_key" ON "stock_exit_lines" ("exitId", "productId");
CREATE INDEX IF NOT EXISTS "stock_exit_lines_productId_idx" ON "stock_exit_lines" ("productId");
DO $$ BEGIN
  ALTER TABLE "stock_exit_lines" ADD CONSTRAINT "stock_exit_lines_quantity_check"
    CHECK ("quantity" > 0 AND ("valueAtCost" IS NULL OR "valueAtCost" >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exit_lines" ADD CONSTRAINT "stock_exit_lines_exitId_fkey"
    FOREIGN KEY ("exitId") REFERENCES "stock_exits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_exit_lines" ADD CONSTRAINT "stock_exit_lines_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
