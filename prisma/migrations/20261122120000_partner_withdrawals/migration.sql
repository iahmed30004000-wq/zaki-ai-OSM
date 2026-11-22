-- «الأرباح: حط شاشة مسحوبات وحط العملات» — the owner, 22/11.
--
-- TWO NEW TABLES, NOTHING ELSE. No existing table or column is touched, no row is written (the standing amounts are typed by the
-- owner on the screen and saved by his own press), and the code that ran before it never reads or writes them. Hand-written; applied
-- locally with `prisma db execute`, recorded with `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at
-- the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261122120000_partner_withdrawals/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261122120000_partner_withdrawals
--
--   partner_standing_amounts — per (partner, currency): the figure the «سجّل مسحوب» press fills in. A setting, not money.
--   partner_withdrawals      — a record of what a partner took, per store and currency. RECORD ONLY: no wallet moves, no expense,
--                              and neither the profit nor the partners' statement reads it. Never edited or deleted; a cancel is a
--                              second row whose "reversalOfId" points at the original (UNIQUE: an original is cancelled once).
--                              "storeId" has no foreign key on purpose (like the other keyless records) — `geo-removal.ts` names it.
--
-- The two CHECKs (amount > 0) cannot be written in schema.prisma; they live only here and are named in its comments.
-- Idempotent (IF NOT EXISTS / guarded constraints). Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "partner_standing_amounts" (
  "id"           TEXT NOT NULL,
  "companyId"    TEXT NOT NULL,
  "partnerId"    TEXT NOT NULL,
  "currencyCode" TEXT NOT NULL,
  "amount"       DECIMAL(14,3) NOT NULL,
  "updatedById"  TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "partner_standing_amounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_standing_amounts_partnerId_currencyCode_key"
  ON "partner_standing_amounts" ("partnerId", "currencyCode");
CREATE INDEX IF NOT EXISTS "partner_standing_amounts_companyId_idx"
  ON "partner_standing_amounts" ("companyId");

CREATE TABLE IF NOT EXISTS "partner_withdrawals" (
  "id"             TEXT NOT NULL,
  "companyId"      TEXT NOT NULL,
  "storeId"        TEXT NOT NULL,
  "partnerId"      TEXT NOT NULL,
  "currencyCode"   TEXT NOT NULL,
  "amount"         DECIMAL(14,3) NOT NULL,
  "withdrawnOn"    DATE NOT NULL,
  "fromStanding"   BOOLEAN NOT NULL DEFAULT false,
  "note"           TEXT,
  "reversalOfId"   TEXT,
  "reversalReason" TEXT,
  "createdById"    TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "partner_withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_withdrawals_reversalOfId_key"
  ON "partner_withdrawals" ("reversalOfId");
CREATE INDEX IF NOT EXISTS "partner_withdrawals_companyId_storeId_createdAt_idx"
  ON "partner_withdrawals" ("companyId", "storeId", "createdAt");
CREATE INDEX IF NOT EXISTS "partner_withdrawals_partnerId_idx"
  ON "partner_withdrawals" ("partnerId");

-- A partner named by a standing amount or a withdrawal cannot be deleted (RESTRICT) — he is switched off instead, as with a draw.
-- An original cannot be deleted from under its reversal (RESTRICT).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_standing_amounts_partnerId_fkey') THEN
    ALTER TABLE "partner_standing_amounts" ADD CONSTRAINT "partner_standing_amounts_partnerId_fkey"
      FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_withdrawals_partnerId_fkey') THEN
    ALTER TABLE "partner_withdrawals" ADD CONSTRAINT "partner_withdrawals_partnerId_fkey"
      FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_withdrawals_reversalOfId_fkey') THEN
    ALTER TABLE "partner_withdrawals" ADD CONSTRAINT "partner_withdrawals_reversalOfId_fkey"
      FOREIGN KEY ("reversalOfId") REFERENCES "partner_withdrawals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_standing_amounts_amount_positive') THEN
    ALTER TABLE "partner_standing_amounts" ADD CONSTRAINT "partner_standing_amounts_amount_positive" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_withdrawals_amount_positive') THEN
    ALTER TABLE "partner_withdrawals" ADD CONSTRAINT "partner_withdrawals_amount_positive" CHECK ("amount" > 0);
  END IF;
END $$;
