-- Stock transfers inside one store (warehouse plan, request W3a): one document with two ends and a road between them.
--
-- ADDITIVE ONLY. Two new, empty tables, their indexes, CHECKs and foreign keys, and ONE foreign key on an existing
-- column that nothing has written yet. Nothing is altered, dropped or backfilled, and NO ROW IS WRITTEN.
--
--   stock_transfers        companyId, storeId (whose goods), kind, fromWarehouseId, toWarehouseId, status, note,
--                          who sent / received / cancelled / approved the difference, and when; the difference's type
--                          (LOSS | DAMAGE) and reason
--   stock_transfer_lines   transferId, productId (one line per product), quantitySent, quantityReceived (null until counted)
--   production_batches.in_transit_transfer_id → stock_transfers.id   (W0a made the column with no key: «its table comes
--                          later». Every row holds NULL today — only a transfer writes it — so the key validates nothing.)
--
-- The CHECKs hold what Prisma cannot say (named in `schema.prisma` above the model): the kind and status words, two
-- different warehouses, the difference type, and 0 ≤ received ≤ sent > 0.
-- Foreign keys: the store RESTRICT (like `warehouse_placements`: a store with a transfer has a history — `geo-removal.ts`
-- lists the table); the two warehouses NO ACTION (a warehouse is never deleted, only stopped — like the batches' key);
-- the batches' key NO ACTION (a transfer is never deleted); a line goes with its transfer and with its product (the
-- product's batches and movements already go with it — a known item of the backlog, not changed here).
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261119200000_stock_transfers/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261119200000_stock_transfers
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "stock_transfers" (
  "id"                     TEXT         NOT NULL,
  "companyId"              TEXT         NOT NULL,
  "storeId"                TEXT         NOT NULL,
  "kind"                   TEXT         NOT NULL,
  "fromWarehouseId"        TEXT         NOT NULL,
  "toWarehouseId"          TEXT         NOT NULL,
  "status"                 TEXT         NOT NULL DEFAULT 'SENT',
  "note"                   TEXT,
  "sentById"               TEXT         NOT NULL,
  "sentAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedById"           TEXT,
  "receivedAt"             TIMESTAMP(3),
  "cancelledById"          TEXT,
  "cancelledAt"            TIMESTAMP(3),
  "cancelReason"           TEXT,
  "differenceType"         TEXT,
  "differenceReason"       TEXT,
  "differenceApprovedById" TEXT,
  "differenceApprovedAt"   TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stock_transfers_companyId_storeId_createdAt_idx" ON "stock_transfers" ("companyId", "storeId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "stock_transfers_fromWarehouseId_status_idx" ON "stock_transfers" ("fromWarehouseId", "status");
CREATE INDEX IF NOT EXISTS "stock_transfers_toWarehouseId_status_idx" ON "stock_transfers" ("toWarehouseId", "status");
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_kind_check"
    CHECK ("kind" IN ('INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_status_check"
    CHECK ("status" IN ('SENT', 'RECEIVED', 'RECEIVED_WITH_DIFFERENCE', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_two_warehouses_check"
    CHECK ("fromWarehouseId" <> "toWarehouseId");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_difference_type_check"
    CHECK ("differenceType" IS NULL OR "differenceType" IN ('LOSS', 'DAMAGE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_fromWarehouseId_fkey"
    FOREIGN KEY ("fromWarehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_toWarehouseId_fkey"
    FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "stock_transfer_lines" (
  "id"               TEXT    NOT NULL,
  "transferId"       TEXT    NOT NULL,
  "productId"        TEXT    NOT NULL,
  "quantitySent"     INTEGER NOT NULL,
  "quantityReceived" INTEGER,
  CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "stock_transfer_lines_transferId_productId_key" ON "stock_transfer_lines" ("transferId", "productId");
CREATE INDEX IF NOT EXISTS "stock_transfer_lines_productId_idx" ON "stock_transfer_lines" ("productId");
DO $$ BEGIN
  ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_quantity_check"
    CHECK ("quantitySent" > 0 AND ("quantityReceived" IS NULL OR ("quantityReceived" >= 0 AND "quantityReceived" <= "quantitySent")));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transferId_fkey"
    FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The road a batch row is on. The column is W0a's; only its key is new.
-- NOT VALID: the key holds every row written from now on, and does not re-read the rows already there. On the first
-- apply they are all NULL (nothing wrote the column before this table existed), so there is nothing to read; after a
-- rollback (which keeps the batches' ids — see rollback.sql) a re-apply would otherwise fail on them. Proven on the
-- scratch database: send → rollback → apply again.
CREATE INDEX IF NOT EXISTS "production_batches_in_transit_transfer_id_idx" ON "production_batches" ("in_transit_transfer_id");
DO $$ BEGIN
  ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_in_transit_transfer_id_fkey"
    FOREIGN KEY ("in_transit_transfer_id") REFERENCES "stock_transfers"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
