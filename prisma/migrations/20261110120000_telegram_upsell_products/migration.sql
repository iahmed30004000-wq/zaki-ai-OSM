-- «أسماء المنتجات» — the product names a Telegram message may carry that are not the catalogue's own (docs/telegram.md):
--   UPSELL  — the name the site's upsell step writes in the SECOND message of one order, and what it adds to the base order;
--   RENAMED — an old name of a catalogue product (orders received before the rename of 2026-11-10), with its old offer texts.
--
-- ONE NEW TABLE, NOTHING ELSE. No existing table gains, loses or changes a column, and no row anywhere is written (the three
-- names of the owner's brief are added from the screen, «أضف الأسماء الجاهزة», never by this file). A new table is a catalogue
-- change only, instant on any database. Hand-written; applied locally with `prisma db execute`, recorded with
-- `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261110120000_telegram_upsell_products/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261110120000_telegram_upsell_products
--
--   telegram_upsell_products — per STORE: the name as the site writes it, its folded match key (unique per store, across
--                              both kinds), the kind, the product of that store it stands for, for an UPSELL how many units
--                              and for how much (per one «الكمية»), for a RENAMED its old offer texts (JSON), and a switch.
--                              Rows are switched off, never deleted, by the screen and the API.
--
-- Idempotent (IF NOT EXISTS / guarded constraints). Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "telegram_upsell_products" (
  "id"           TEXT NOT NULL,
  "companyId"    TEXT NOT NULL,
  "storeId"      TEXT NOT NULL,
  "incomingName" TEXT NOT NULL,
  "foldedName"   TEXT NOT NULL,
  "productId"    TEXT NOT NULL,
  "kind"         TEXT NOT NULL DEFAULT 'UPSELL',
  "extraUnits"   INTEGER,
  "linePrice"    DECIMAL(14,3),
  "offerAliases" JSONB,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "telegram_upsell_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "telegram_upsell_products_companyId_storeId_foldedName_key"
  ON "telegram_upsell_products" ("companyId", "storeId", "foldedName");
CREATE INDEX IF NOT EXISTS "telegram_upsell_products_companyId_storeId_isActive_idx"
  ON "telegram_upsell_products" ("companyId", "storeId", "isActive");
CREATE INDEX IF NOT EXISTS "telegram_upsell_products_productId_idx" ON "telegram_upsell_products" ("productId");

-- The foreign keys: a company or a store that goes takes its own names with it; a PRODUCT named here cannot be deleted
-- while a name points at it (RESTRICT) — switch the name off, or point it at another product, first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_upsell_products_companyId_fkey') THEN
    ALTER TABLE "telegram_upsell_products" ADD CONSTRAINT "telegram_upsell_products_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_upsell_products_storeId_fkey') THEN
    ALTER TABLE "telegram_upsell_products" ADD CONSTRAINT "telegram_upsell_products_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_upsell_products_productId_fkey') THEN
    ALTER TABLE "telegram_upsell_products" ADD CONSTRAINT "telegram_upsell_products_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
