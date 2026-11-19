-- Product authenticity codes (public barcode/QR checker): one new, empty table and nothing else.
-- ADDITIVE ONLY: no existing table, column or row is touched.
--   authenticity_codes   one row per code the owner typed in by hand at /settings/authenticity;
--                        a public scan of /verify/[store] looks a code up here and answers only
--                        genuine/not genuine — never the row itself.
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261119120000_authenticity_codes/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261119120000_authenticity_codes
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "authenticity_codes" (
  "id"            TEXT         NOT NULL,
  "companyId"     TEXT         NOT NULL,
  "code"          TEXT         NOT NULL,
  "note"          TEXT,
  "productId"     TEXT,
  "scanCount"     INTEGER      NOT NULL DEFAULT 0,
  "last_scan_at"  TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" TEXT,
  CONSTRAINT "authenticity_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "authenticity_codes_companyId_code_key" ON "authenticity_codes" ("companyId", "code");
CREATE INDEX IF NOT EXISTS "authenticity_codes_companyId_idx" ON "authenticity_codes" ("companyId");

DO $$ BEGIN
  ALTER TABLE "authenticity_codes" ADD CONSTRAINT "authenticity_codes_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "authenticity_codes" ADD CONSTRAINT "authenticity_codes_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
