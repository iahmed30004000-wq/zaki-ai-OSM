-- «فرق التحصيل على الموظف» — a collection shortfall becomes a charge that waits for a decision.
--
-- When an approval accepts the courier's figure and the company paid LESS than was expected (s > 0), the
-- difference falls on the employee who followed the parcel, unless the owner or the accountant accepts the
-- explanation. This file is the schema and the grant that rule needs. It changes no row of money.
--
-- THREE THINGS, ALL ADDITIVE OR LOOSER:
--
--   1. penalties.settlement_match_id (FK RESTRICT) — the statement line a «فرق تحصيل» is about. Null on every
--      charge a rule measured. payslips gains settled_amount / settled_currency / settled_rate — deductions in
--      another currency than the salary's, converted at payment at a rate the payer typed, stored with the
--      payslip and never recalculated. All new columns are nullable: no existing row changes.
--
--   2. The two partial unique indexes.
--      · penalties_one_live_per_day gains «AND settlement_match_id IS NULL». It is a RELAXATION: every set of
--        rows the old index allowed, the new one allows — so it cannot fail on existing data. It is dropped and
--        created again in the same batch, so there is no moment without it. Two short orders delivered on one
--        day are two differences; the old index would have refused the second.
--      · penalties_one_live_per_match — one live charge (PROPOSED or APPLIED) per statement line. A second
--        press of «اعتماد», or a retry, can never charge the same difference twice.
--
--   3. «اعتماد الخصومات أو إلغاؤها» (penalties.decide) goes to the ACCOUNTANT — and «عرض الخصومات المقترحة»
--      (penalties.view) with it, because the decision is taken on the screen and read from the list that key
--      opens: a decide key without the view key is a door to a room with no entrance. The owner has both
--      through the code bypass. No other role gains anything, and nobody loses anything.
--
-- THE GRANT IS INSERT … ON CONFLICT DO NOTHING. No row is changed or removed, so a role that already holds
-- either key keeps exactly the row it had. Every row written here has an id starting with 'sfl-', which is how
-- rollback.sql finds them and nothing else.
--
-- THE BASELINE IS WRITTEN ONLY WHERE ONE EXISTS. «إرجاع للافتراضي» reads role_permission_defaults, and a role
-- with no rows there answers «no baseline» — a lone row would turn that into a baseline holding these two keys,
-- and restoring it would wipe the role. (The same lesson as 20261029000000_tracking_returns_view_key.)
--
-- HOW IT IS APPLIED — by the owner's press, never by a deploy:
--   npx prisma db execute --file prisma/migrations/20261029120000_shortfall_penalty/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261029120000_shortfall_penalty

-- 1. The columns.
ALTER TABLE "penalties" ADD COLUMN IF NOT EXISTS "settlement_match_id" TEXT;

ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "settled_amount" DECIMAL(14,3);
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "settled_currency" TEXT;
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "settled_rate" DECIMAL(14,6);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'penalties_settlement_match_id_fkey') THEN
    ALTER TABLE "penalties" ADD CONSTRAINT "penalties_settlement_match_id_fkey"
      FOREIGN KEY ("settlement_match_id") REFERENCES "settlement_matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "penalties_settlement_match_id_idx" ON "penalties"("settlement_match_id");

-- 2. The indexes.
DROP INDEX IF EXISTS "penalties_one_live_per_day";
CREATE UNIQUE INDEX "penalties_one_live_per_day"
  ON "penalties"("company_id", "user_id", "kind", "occurred_on")
  WHERE "status" IN ('PROPOSED', 'APPLIED') AND "settlement_match_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "penalties_one_live_per_match"
  ON "penalties"("settlement_match_id")
  WHERE "status" IN ('PROPOSED', 'APPLIED') AND "settlement_match_id" IS NOT NULL;

-- 3. The accountant decides, and sees what she decides.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'sfl-' || gen_random_uuid()::text, r."id", k."permission", 'ALL_COMPANY', NULL
FROM "roles" r
CROSS JOIN (VALUES ('penalties.view'), ('penalties.decide')) AS k("permission")
WHERE r."name" = 'ACCOUNTANT'
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'sfl-' || gen_random_uuid()::text, r."id", k."permission", 'ALL_COMPANY', NULL
FROM "roles" r
CROSS JOIN (VALUES ('penalties.view'), ('penalties.decide')) AS k("permission")
WHERE r."name" = 'ACCOUNTANT'
  AND EXISTS (SELECT 1 FROM "role_permission_defaults" b WHERE b."roleId" = r."id")
ON CONFLICT ("roleId", "permission") DO NOTHING;
