-- «السلات المهجورة» — the abandoned carts Zaki pages sends through the landing door (contract oms-lp.v1 §9), and the team's
-- work on them.
--
-- TWO NEW TABLES, NOTHING ELSE. No existing table or column is touched, no row is written, and the code that ran before
-- this never reads them. A new table is a catalogue change, instant whatever the size of the database. Hand-written (it is
-- exactly what `prisma migrate diff` prints for the schema change, made idempotent); applied locally with
-- `prisma db execute`, recorded with `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the
-- owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261115120000_abandoned_carts/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261115120000_abandoned_carts
--
--   abandoned_carts            — one row per (company, externalId): the lead as Zaki pages sent it, its normalised phone,
--                                the status the team moves it through, its attempts, follow-up date, assignee, and the
--                                order it became. Its product, region, order and assignee are SET NULL when they go: a
--                                cart outlives a deleted product. A company that goes takes its carts with it.
--   abandoned_cart_activities  — the cart's history and notes, one line each; goes with its cart.
--
-- Idempotent (IF NOT EXISTS / guarded constraints). Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "abandoned_carts" (
    "id"              TEXT NOT NULL,
    "companyId"       TEXT NOT NULL,
    "externalId"      TEXT NOT NULL,
    "source"          TEXT NOT NULL DEFAULT 'LANDING_PAGE',
    "landingPageId"   TEXT,
    "landingPageName" TEXT,
    "landingPageUrl"  TEXT,
    "productId"       TEXT,
    "productName"     TEXT,
    "customerName"    TEXT,
    "phone"           TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "city"            TEXT,
    "regionId"        TEXT,
    "country"         TEXT,
    "firstSeenAt"     TIMESTAMP(3) NOT NULL,
    "lastSeenAt"      TIMESTAMP(3) NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'NEW',
    "orderId"         TEXT,
    "assignedToId"    TEXT,
    "nextFollowUpAt"  TIMESTAMP(3),
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abandoned_carts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "abandoned_cart_activities" (
    "id"         TEXT NOT NULL,
    "companyId"  TEXT NOT NULL,
    "cartId"     TEXT NOT NULL,
    "userId"     TEXT,
    "action"     TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus"   TEXT,
    "note"       TEXT,
    "metadata"   TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abandoned_cart_activities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "abandoned_carts_companyId_externalId_key"
  ON "abandoned_carts" ("companyId", "externalId");
CREATE INDEX IF NOT EXISTS "abandoned_carts_companyId_status_lastSeenAt_idx"
  ON "abandoned_carts" ("companyId", "status", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "abandoned_carts_companyId_lastSeenAt_idx"
  ON "abandoned_carts" ("companyId", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "abandoned_carts_companyId_phoneNormalized_idx"
  ON "abandoned_carts" ("companyId", "phoneNormalized");
CREATE INDEX IF NOT EXISTS "abandoned_carts_companyId_assignedToId_idx"
  ON "abandoned_carts" ("companyId", "assignedToId");
CREATE INDEX IF NOT EXISTS "abandoned_carts_productId_idx"
  ON "abandoned_carts" ("productId");
CREATE INDEX IF NOT EXISTS "abandoned_cart_activities_cartId_createdAt_idx"
  ON "abandoned_cart_activities" ("cartId", "createdAt");
CREATE INDEX IF NOT EXISTS "abandoned_cart_activities_companyId_idx"
  ON "abandoned_cart_activities" ("companyId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_carts_companyId_fkey') THEN
    ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_carts_productId_fkey') THEN
    ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_carts_regionId_fkey') THEN
    ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_regionId_fkey"
      FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_carts_orderId_fkey') THEN
    ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_carts_assignedToId_fkey') THEN
    ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_assignedToId_fkey"
      FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_cart_activities_companyId_fkey') THEN
    ALTER TABLE "abandoned_cart_activities" ADD CONSTRAINT "abandoned_cart_activities_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_cart_activities_cartId_fkey') THEN
    ALTER TABLE "abandoned_cart_activities" ADD CONSTRAINT "abandoned_cart_activities_cartId_fkey"
      FOREIGN KEY ("cartId") REFERENCES "abandoned_carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_cart_activities_userId_fkey') THEN
    ALTER TABLE "abandoned_cart_activities" ADD CONSTRAINT "abandoned_cart_activities_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
