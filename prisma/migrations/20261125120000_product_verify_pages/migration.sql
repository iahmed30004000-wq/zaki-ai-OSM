-- Product barcode pages («باركود المنتجات»): one new, empty table and nothing else.
-- ADDITIVE ONLY: no existing table, column or row is touched.
--   product_verify_pages   at most one row per product: the owner's design of that product's public page
--                          /verify/p/<public_id>. The page checks a piece's authenticity code against
--                          authenticity_codes (a code tagged to this product, or to none) and answers only
--                          genuine / not genuine.
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261125120000_product_verify_pages/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261125120000_product_verify_pages
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "product_verify_pages" (
  "id"                  TEXT         NOT NULL,
  "companyId"           TEXT         NOT NULL,
  "product_id"          TEXT         NOT NULL,
  "public_id"           TEXT         NOT NULL,
  "slug"                TEXT         NOT NULL,
  "active"             BOOLEAN      NOT NULL DEFAULT true,
  "headline"            TEXT,
  "name_override"       TEXT,
  "image_url"           TEXT,
  "logo_url"            TEXT,
  "primary_color"       TEXT,
  "background_color"    TEXT,
  "description"         TEXT,
  "features"            TEXT         NOT NULL DEFAULT '[]',
  "genuine_message"     TEXT,
  "not_genuine_message" TEXT,
  "whatsapp_number"     TEXT,
  "reorder_mode"        TEXT         NOT NULL DEFAULT 'landing',
  "reorder_url"         TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  "created_by_id"       TEXT,
  CONSTRAINT "product_verify_pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_verify_pages_product_id_key" ON "product_verify_pages" ("product_id");
CREATE UNIQUE INDEX IF NOT EXISTS "product_verify_pages_public_id_key" ON "product_verify_pages" ("public_id");
CREATE UNIQUE INDEX IF NOT EXISTS "product_verify_pages_slug_key" ON "product_verify_pages" ("slug");
CREATE INDEX IF NOT EXISTS "product_verify_pages_companyId_idx" ON "product_verify_pages" ("companyId");

-- The slugs a page used to have: /v/<old> redirects (308) to the current one, and an old slug is never given to
-- another page — a printed barcode must never open somebody else's product.
CREATE TABLE IF NOT EXISTS "product_verify_page_slugs" (
  "slug"      TEXT         NOT NULL,
  "page_id"   TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_verify_page_slugs_pkey" PRIMARY KEY ("slug")
);
CREATE INDEX IF NOT EXISTS "product_verify_page_slugs_page_id_idx" ON "product_verify_page_slugs" ("page_id");

DO $$ BEGIN
  ALTER TABLE "product_verify_pages" ADD CONSTRAINT "product_verify_pages_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "product_verify_pages" ADD CONSTRAINT "product_verify_pages_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "product_verify_pages" ADD CONSTRAINT "product_verify_pages_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "product_verify_page_slugs" ADD CONSTRAINT "product_verify_page_slugs_page_id_fkey"
    FOREIGN KEY ("page_id") REFERENCES "product_verify_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
