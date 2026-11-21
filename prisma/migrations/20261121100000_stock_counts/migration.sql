-- Count sheets (warehouse plan, request W5a): the keeper counts one warehouse blind, a different person approves, and
-- each difference is applied by the recount's own arithmetic in that warehouse.
--
-- ADDITIVE ONLY. Three new, empty tables with their indexes, CHECKs and foreign keys. Nothing existing is altered,
-- dropped or backfilled, and NO ROW IS WRITTEN.
--
--   stock_counts               companyId, storeId (whose goods), warehouseId, status, scope, note, who opened, who
--                              submitted, who decided (approved or voided) and when, the void's reason
--   stock_count_lines          countId, productId (one line per product), counted (+ who, when), the figures frozen at
--                              submit (book, withCourier, expected, unsourcedWithCourier), and at approval the applied
--                              difference and its value at cost
--   stock_count_line_variants  lineId, countId, productId, variantId, counted, expected (frozen at submit)
--
-- The CHECKs and the partial unique index hold what Prisma cannot say (named in `schema.prisma` above the model): the
-- four statuses, the two scopes, ONE open sheet per warehouse (OPEN or SUBMITTED), and counts that are never negative.
-- Foreign keys: the store RESTRICT (like `stock_exits`: a store with a count has a history — `geo-removal.ts` lists the
-- table); the warehouse NO ACTION (a warehouse is never deleted, only stopped); a line goes with its sheet and with its
-- product.
--
-- No money: no wallet, expense or profit table is named here or written by the count doors.
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261121100000_stock_counts/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261121100000_stock_counts
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "stock_counts" (
  "id"            TEXT         NOT NULL,
  "companyId"     TEXT         NOT NULL,
  "storeId"       TEXT         NOT NULL,
  "warehouseId"   TEXT         NOT NULL,
  "status"        TEXT         NOT NULL DEFAULT 'OPEN',
  "scope"         TEXT         NOT NULL DEFAULT 'ALL',
  "note"          TEXT,
  "openedById"    TEXT         NOT NULL,
  "openedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedById" TEXT,
  "submittedAt"   TIMESTAMP(3),
  "decidedById"   TEXT,
  "decidedAt"     TIMESTAMP(3),
  "voidReason"    TEXT,
  "writerIds"     TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);
-- Every person who ever wrote a line (the two-hands rule). Also as its own idempotent line, for a database that took this
-- file before the column was added to it (review of #445).
ALTER TABLE "stock_counts" ADD COLUMN IF NOT EXISTS "writerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX IF NOT EXISTS "stock_counts_companyId_storeId_createdAt_idx" ON "stock_counts" ("companyId", "storeId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "stock_counts_warehouseId_status_idx" ON "stock_counts" ("warehouseId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "stock_counts_one_open_per_warehouse" ON "stock_counts" ("warehouseId")
  WHERE "status" IN ('OPEN', 'SUBMITTED');
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_status_check"
    CHECK ("status" IN ('OPEN', 'SUBMITTED', 'APPROVED', 'VOIDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_scope_check"
    CHECK ("scope" IN ('ALL', 'CHOSEN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "stock_count_lines" (
  "id"                   TEXT             NOT NULL,
  "countId"              TEXT             NOT NULL,
  "productId"            TEXT             NOT NULL,
  "counted"              INTEGER,
  "countedById"          TEXT,
  "countedAt"            TIMESTAMP(3),
  "book"                 INTEGER,
  "withCourier"          INTEGER,
  "expected"             INTEGER,
  "unsourcedWithCourier" INTEGER,
  "applied"              INTEGER,
  "valueAtCost"          DOUBLE PRECISION,
  CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "stock_count_lines_countId_productId_key" ON "stock_count_lines" ("countId", "productId");
CREATE INDEX IF NOT EXISTS "stock_count_lines_productId_idx" ON "stock_count_lines" ("productId");
DO $$ BEGIN
  ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_counted_check"
    CHECK ("counted" IS NULL OR "counted" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_countId_fkey"
    FOREIGN KEY ("countId") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "stock_count_line_variants" (
  "id"        TEXT    NOT NULL,
  "lineId"    TEXT    NOT NULL,
  "countId"   TEXT    NOT NULL,
  "productId" TEXT    NOT NULL,
  "variantId" TEXT    NOT NULL,
  "counted"   INTEGER NOT NULL,
  "expected"  INTEGER,
  CONSTRAINT "stock_count_line_variants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "stock_count_line_variants_lineId_variantId_key" ON "stock_count_line_variants" ("lineId", "variantId");
CREATE INDEX IF NOT EXISTS "stock_count_line_variants_countId_idx" ON "stock_count_line_variants" ("countId");
CREATE INDEX IF NOT EXISTS "stock_count_line_variants_variantId_idx" ON "stock_count_line_variants" ("variantId");
DO $$ BEGIN
  ALTER TABLE "stock_count_line_variants" ADD CONSTRAINT "stock_count_line_variants_counted_check" CHECK ("counted" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_count_line_variants" ADD CONSTRAINT "stock_count_line_variants_lineId_fkey"
    FOREIGN KEY ("lineId") REFERENCES "stock_count_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stock_count_line_variants" ADD CONSTRAINT "stock_count_line_variants_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
