-- The opening placement (warehouse plan, request W1a): one row per store, written once, in the same transaction that
-- gives the store's batches their warehouse. Until a store has its row, every stock door behaves exactly as before.
--
-- ADDITIVE ONLY. One new, empty table, its indexes and one foreign key. Nothing is altered, dropped or backfilled, and
-- NO ROW IS WRITTEN — no store is placed by this migration; the owner places each store from its screen.
--
--   warehouse_placements   companyId, storeId (one per store), countedByName (free text: the keeper may have no login),
--                          countedAt, note, recordedById (who pressed), createdAt
--
-- The store's foreign key is RESTRICT, like `stock_opening_counts`: a store whose stock was placed is a store with a
-- history, and `geo-removal.ts` refuses to remove it (the row is listed there).
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261119140000_warehouse_placements/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261119140000_warehouse_placements
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "warehouse_placements" (
  "id"            TEXT         NOT NULL,
  "companyId"     TEXT         NOT NULL,
  "storeId"       TEXT         NOT NULL,
  "countedByName" TEXT         NOT NULL,
  "countedAt"     TIMESTAMP(3) NOT NULL,
  "note"          TEXT,
  "recordedById"  TEXT         NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_placements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_placements_storeId_key" ON "warehouse_placements" ("storeId");
CREATE INDEX IF NOT EXISTS "warehouse_placements_companyId_countedAt_idx" ON "warehouse_placements" ("companyId", "countedAt");
DO $$ BEGIN
  ALTER TABLE "warehouse_placements" ADD CONSTRAINT "warehouse_placements_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
