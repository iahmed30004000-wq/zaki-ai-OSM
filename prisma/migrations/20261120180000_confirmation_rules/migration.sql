-- «قواعد خاصة» of the confirmation desk (rules plan, request Q4a): one new, EMPTY table and nothing else.
-- ADDITIVE ONLY: no existing table, column or row is touched, and NO ROW IS WRITTEN — the ready templates are data in
-- src/lib/confirmation-rules.ts (CONFIRMATION_RULE_TEMPLATES), OFF until the owner turns one on from the screen.
--   confirmation_rules   a rule the owner writes on top of the one base rule: company, store (nullable), name, kind,
--                        who (null = everyone, else a JSON array of user ids), product / channel kind / phase / hours
--                        (all nullable), the dates, is_active, the payload of its kind, who created it.
--                        Shaped like penalty_rules. Never deleted: a rule is stopped (is_active = false) and stays.
-- Nothing reads the table in this request: `ruleFor` resolves from its rows, and zero rows answers the base rule exactly.
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS / duplicate_object).
-- Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261120180000_confirmation_rules/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261120180000_confirmation_rules
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "confirmation_rules" (
  "id"             TEXT         NOT NULL,
  "company_id"     TEXT         NOT NULL,
  "store_id"       TEXT,
  "name"           TEXT         NOT NULL,
  "kind"           TEXT         NOT NULL,
  "user_ids"       JSONB,
  "product_id"     TEXT,
  "channel_kind"   TEXT,
  "phase"          TEXT,
  "hours_from"     TEXT,
  "hours_to"       TEXT,
  "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_to"   TIMESTAMP(3),
  "is_active"      BOOLEAN      NOT NULL DEFAULT true,
  "payload"        JSONB        NOT NULL,
  "created_by_id"  TEXT         NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "confirmation_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "confirmation_rules_company_id_is_active_idx" ON "confirmation_rules" ("company_id", "is_active");
CREATE INDEX IF NOT EXISTS "confirmation_rules_company_id_store_id_idx" ON "confirmation_rules" ("company_id", "store_id");

DO $$ BEGIN
  ALTER TABLE "confirmation_rules" ADD CONSTRAINT "confirmation_rules_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
