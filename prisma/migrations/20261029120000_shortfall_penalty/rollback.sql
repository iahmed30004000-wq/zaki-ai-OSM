-- Rollback for 20261029120000_shortfall_penalty.
-- Run ONLY after the code that writes a «فرق تحصيل» is reverted.
--
-- 1. The grants. Removes only the rows that migration wrote (ids starting with 'sfl-'). A row the owner saved
--    again since then has a new id and is his — it stays.
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'sfl-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'sfl-%';

-- 2. The schema. REFUSES, rather than losing a charge or a conversion: if any «فرق تحصيل» row or any converted
--    payslip exists, nothing below runs and the batch stops with the sentence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "penalties" WHERE "settlement_match_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'shortfall rollback refused: penalties tied to a statement line exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "payslips" WHERE "settled_amount" IS NOT NULL OR "settled_currency" IS NOT NULL OR "settled_rate" IS NOT NULL) THEN
    RAISE EXCEPTION 'shortfall rollback refused: payslips with a converted deduction exist';
  END IF;
END $$;

DROP INDEX IF EXISTS "penalties_one_live_per_match";
DROP INDEX IF EXISTS "penalties_one_live_per_day";
CREATE UNIQUE INDEX "penalties_one_live_per_day"
  ON "penalties"("company_id", "user_id", "kind", "occurred_on")
  WHERE "status" IN ('PROPOSED', 'APPLIED');

ALTER TABLE "penalties" DROP CONSTRAINT IF EXISTS "penalties_settlement_match_id_fkey";
DROP INDEX IF EXISTS "penalties_settlement_match_id_idx";
ALTER TABLE "penalties" DROP COLUMN IF EXISTS "settlement_match_id";
ALTER TABLE "payslips" DROP COLUMN IF EXISTS "settled_amount";
ALTER TABLE "payslips" DROP COLUMN IF EXISTS "settled_currency";
ALTER TABLE "payslips" DROP COLUMN IF EXISTS "settled_rate";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029120000_shortfall_penalty';
