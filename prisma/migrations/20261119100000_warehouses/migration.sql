-- Warehouses (the first request of the warehouse plan): a warehouse is a place of one country, and a person
-- may be confined to the warehouses she keeps. INERT: nothing in this release reads or writes the new columns
-- on batches, movements, shipments or orders — every store behaves exactly as before.
--
-- ADDITIVE ONLY. Two new, empty tables; nullable or defaulted columns; indexes; foreign keys. Nothing is
-- altered, dropped or backfilled, and NO ROW IS WRITTEN (the two defaulted integer columns are filled by the
-- column default, which is 0 — the same as «nothing moved»).
--
--   warehouses                                  companyId, countryId, name, isActive; one name per country
--   user_warehouse_access                       userId, warehouseId; one row per pair
--   production_batches.warehouse_id             TEXT NULL     where the units are (NULL = not placed)
--   production_batches.quantity_moved_in        INT  DEFAULT 0
--   production_batches.quantity_moved_out       INT  DEFAULT 0
--   production_batches.split_from_batch_id      TEXT NULL     the parent of a split twin
--   production_batches.in_transit_transfer_id   TEXT NULL     no foreign key yet: its table comes later
--   inventory_movements.warehouse_id            TEXT NULL
--   shipping_batches."warehouseId"              TEXT NULL     (this table is camelCase throughout)
--   orders."sourceWarehouseId"                  TEXT NULL     (this table is camelCase throughout)
--
-- The foreign keys onto warehouses are NO ACTION, not RESTRICT: a warehouse is never deleted by a door (it is
-- stopped), and NO ACTION still lets a company's own cascade remove both sides in one statement.
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261119100000_warehouses/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261119100000_warehouses
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "warehouses" (
  "id"        TEXT         NOT NULL,
  "companyId" TEXT         NOT NULL,
  "countryId" TEXT         NOT NULL,
  "name"      TEXT         NOT NULL,
  "isActive"  BOOLEAN      NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "warehouses_companyId_countryId_name_key" ON "warehouses" ("companyId", "countryId", "name");
CREATE INDEX IF NOT EXISTS "warehouses_companyId_isActive_idx" ON "warehouses" ("companyId", "isActive");
CREATE INDEX IF NOT EXISTS "warehouses_countryId_idx" ON "warehouses" ("countryId");
DO $$ BEGIN
  ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_countryId_fkey"
    FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "user_warehouse_access" (
  "id"          TEXT         NOT NULL,
  "userId"      TEXT         NOT NULL,
  "warehouseId" TEXT         NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_warehouse_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_warehouse_access_userId_warehouseId_key" ON "user_warehouse_access" ("userId", "warehouseId");
CREATE INDEX IF NOT EXISTS "user_warehouse_access_warehouseId_idx" ON "user_warehouse_access" ("warehouseId");
DO $$ BEGIN
  ALTER TABLE "user_warehouse_access" ADD CONSTRAINT "user_warehouse_access_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "user_warehouse_access" ADD CONSTRAINT "user_warehouse_access_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Batches: where, and the two move counters.
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "warehouse_id" TEXT;
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "quantity_moved_in" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "quantity_moved_out" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "split_from_batch_id" TEXT;
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "in_transit_transfer_id" TEXT;
CREATE INDEX IF NOT EXISTS "production_batches_companyId_productId_warehouse_id_idx" ON "production_batches" ("companyId", "productId", "warehouse_id");
CREATE INDEX IF NOT EXISTS "production_batches_split_from_batch_id_idx" ON "production_batches" ("split_from_batch_id");
DO $$ BEGIN
  ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_warehouse_id_fkey"
    FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_split_from_batch_id_fkey"
    FOREIGN KEY ("split_from_batch_id") REFERENCES "production_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The ledger: which shelf moved.
ALTER TABLE "inventory_movements" ADD COLUMN IF NOT EXISTS "warehouse_id" TEXT;
CREATE INDEX IF NOT EXISTS "inventory_movements_companyId_warehouse_id_createdAt_idx" ON "inventory_movements" ("companyId", "warehouse_id", "createdAt" DESC);
DO $$ BEGIN
  ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_fkey"
    FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A shipment is packed in one warehouse.
ALTER TABLE "shipping_batches" ADD COLUMN IF NOT EXISTS "warehouseId" TEXT;
CREATE INDEX IF NOT EXISTS "shipping_batches_warehouseId_idx" ON "shipping_batches" ("warehouseId");
DO $$ BEGIN
  ALTER TABLE "shipping_batches" ADD CONSTRAINT "shipping_batches_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An order says where it left from.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sourceWarehouseId" TEXT;
CREATE INDEX IF NOT EXISTS "orders_sourceWarehouseId_idx" ON "orders" ("sourceWarehouseId");
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_sourceWarehouseId_fkey"
    FOREIGN KEY ("sourceWarehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
