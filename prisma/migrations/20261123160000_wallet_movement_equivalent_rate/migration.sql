-- THE RATE A PARTNER'S DRAW WAS CONVERTED AT (2026-11-23, F8 «سعر الصرف التلقائي»).
--
--   "equivalentRate"        store-currency units for ONE wallet unit, as multiplied when the draw was written.
--   "equivalentRateKind"    AUTO (from the internet) or MANUAL (a rate the owner typed in «أسعار الصرف»).
--   "equivalentRateSource"  the source's name for an AUTO rate (e.g. open.er-api.com); NULL for MANUAL.
--   "equivalentRateAt"      when that rate was true.
--
-- Written ONLY when the server filled the draw's equivalent itself from today's rate (the person left it empty). FROZEN: a later
-- rate never rewrites them, and nothing that adds money up reads them — the partners' ledger keeps reading the stored equivalent.
-- NULL on every other movement and on every row that exists today: no backfill.
--
-- ADDITIVE ONLY: four nullable columns and two CHECKs (named in a comment in schema.prisma), no default, no index, no row changed.

ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "equivalentRate" DECIMAL(24,12);
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "equivalentRateKind" TEXT;
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "equivalentRateSource" TEXT;
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "equivalentRateAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_movements_equivalent_rate_check') THEN
    ALTER TABLE "wallet_movements" ADD CONSTRAINT "wallet_movements_equivalent_rate_check"
      CHECK ("equivalentRate" IS NULL OR ("equivalentRate" > 0 AND "equivalentRateKind" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_movements_equivalent_rate_kind_check') THEN
    ALTER TABLE "wallet_movements" ADD CONSTRAINT "wallet_movements_equivalent_rate_kind_check"
      CHECK ("equivalentRateKind" IS NULL OR ("equivalentRateKind" IN ('AUTO', 'MANUAL') AND "equivalentRate" IS NOT NULL));
  END IF;
END $$;
