-- «احنا ٤ شركاء … الربح لازم يتم توزيعه وفق هاي النسب، والسحوبات لازم تنضاف بند وتكون وفق هاي النسب» — the owner, 13/11.
--
-- ONE NEW TABLE AND TWO NEW NULLABLE COLUMNS, NOTHING ELSE. No row is written anywhere (the four partners are typed into the settings
-- card and saved by the owner's own press, never by this file or by a seed), no existing column is touched or given a default, and
-- the code that ran before it never reads or writes the new ones. A new table is a catalogue change; two nullable columns without a
-- default are a catalogue change too — instant on `wallet_movements` whatever its size. Hand-written; applied locally with
-- `prisma db execute`, recorded with `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the
-- owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261113120000_partners_and_draws/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261113120000_partners_and_draws
--
--   partners                              — per COMPANY: the name, the share of the net profit (0 < x <= 100, two decimals), whether he
--                                           is in the split, and the order the screens list them in. Unique per (company, name). The
--                                           active shares total exactly 100.00 — held by the settings door, NOT by the database: a
--                                           share may be re-cut in two saves, and a CHECK across rows cannot be written here anyway.
--   wallet_movements.partnerId            — the partner a PARTNER_DRAW is the withdrawal of. NULL on every movement written before this
--                                           and on every other kind. RESTRICT: a partner who has a draw cannot be deleted.
--   wallet_movements.valueInStoreCurrency — what the draw is worth in the STORE's currency (the profit's currency), the number the
--                                           partner ledger adds up. NULL on every other kind.
--
-- Idempotent (IF NOT EXISTS / guarded constraints). Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "partners" (
  "id"           TEXT NOT NULL,
  "companyId"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "sharePercent" DECIMAL(5,2) NOT NULL,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "partners_companyId_name_key"
  ON "partners" ("companyId", "name");
CREATE INDEX IF NOT EXISTS "partners_companyId_isActive_sortOrder_idx"
  ON "partners" ("companyId", "isActive", "sortOrder");

ALTER TABLE "wallet_movements"
  ADD COLUMN IF NOT EXISTS "partnerId"            TEXT,
  ADD COLUMN IF NOT EXISTS "valueInStoreCurrency" DECIMAL(14,3);

CREATE INDEX IF NOT EXISTS "wallet_movements_partnerId_idx"
  ON "wallet_movements" ("partnerId");

-- The foreign keys and the one CHECK. A company that goes takes its partners with it; a PARTNER named by a movement cannot be
-- deleted (RESTRICT) — switch him off instead. The CHECK is the range of a share; Prisma cannot express it, so it lives only here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_companyId_fkey') THEN
    ALTER TABLE "partners" ADD CONSTRAINT "partners_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_movements_partnerId_fkey') THEN
    ALTER TABLE "wallet_movements" ADD CONSTRAINT "wallet_movements_partnerId_fkey"
      FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_sharePercent_range') THEN
    ALTER TABLE "partners" ADD CONSTRAINT "partners_sharePercent_range"
      CHECK ("sharePercent" > 0 AND "sharePercent" <= 100);
  END IF;
END $$;
