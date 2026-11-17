-- «إعدادات الربط من الموقع» (the media buyer's doors, PR-C, 18/11): the WhatsApp and Telegram settings entered on «الإعدادات ← الربط» instead of the server's environment.
-- ADDITIVE ONLY: ONE NEW TABLE, empty. Nothing is altered, dropped or backfilled; with no row the code reads the environment variable exactly as it did.
--
--   integration_secrets("key" unique = the variable's own name, "valueEncrypted" sealed by the application, "hint" = the last four characters, who and when)
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261118120000_integration_secrets/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261118120000_integration_secrets
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy (docker-entrypoint.sh runs it BEFORE the new image serves). Rollback: rollback.sql beside this file.
CREATE TABLE IF NOT EXISTS "integration_secrets" (
  "id"             TEXT         NOT NULL,
  "key"            TEXT         NOT NULL,
  "valueEncrypted" TEXT         NOT NULL,
  "hint"           TEXT         NOT NULL,
  "updatedById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "integration_secrets_key_key" ON "integration_secrets" ("key");
