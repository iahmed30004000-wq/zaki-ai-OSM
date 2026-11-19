-- «سجل الرفض» (confirmation desk refusal log): one new, empty table and nothing else.
-- ADDITIVE ONLY: no existing table, column or row is touched; no row is written.
--   desk_refusals   one row each time a confirmation-desk rule refuses somebody (src/lib/desk-refusals.ts):
--                   company, store, user, order (nullable), the refusal's code and the door. Ids and codes only —
--                   no customer field. Kept 90 days (job prune-desk-refusals).
-- No foreign keys on purpose (see the model's comment in schema.prisma): the log must never fail a door.
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261119180000_desk_refusals/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261119180000_desk_refusals
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "desk_refusals" (
  "id"        TEXT         NOT NULL,
  "companyId" TEXT         NOT NULL,
  "storeId"   TEXT,
  "userId"    TEXT         NOT NULL,
  "orderId"   TEXT,
  "code"      TEXT         NOT NULL,
  "door"      TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "desk_refusals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "desk_refusals_companyId_storeId_createdAt_idx" ON "desk_refusals" ("companyId", "storeId", "createdAt");
CREATE INDEX IF NOT EXISTS "desk_refusals_companyId_userId_createdAt_idx" ON "desk_refusals" ("companyId", "userId", "createdAt");
