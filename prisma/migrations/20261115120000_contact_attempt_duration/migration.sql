-- «مدة المحاولة» — step A of Confirmation Center v2 (provable call attempts): ONE NULLABLE COLUMN ON ONE TABLE.
--
--   order_contact_attempts."durationSeconds" INTEGER
--       Written only while the company switch «إثبات المكالمات وجدول المحاولات» is ON (Company.settings.callProofAndCadence, no column for it): for a
--       no-answer-class line, the server's measure of the ring window (the «اتصال» press -> this line); for an answered / call-back line, the phone's figure.
--       NULL on every row that exists today and on every line that is not timed; NULL means «not measured», never zero.
--
-- ADDITIVE ONLY: no default, no backfill, no index, no row changed. A nullable ADD COLUMN without a default is a catalogue-only change in PostgreSQL (the table held
-- about 14,300 rows on 14/11). The code that ran before never selects the column and is not affected by its being there. Hand-written (AGENTS.md: never
-- `migrate dev`, never a reset), with IF NOT EXISTS. Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261115120000_contact_attempt_duration/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261115120000_contact_attempt_duration
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy (docker-entrypoint.sh runs it BEFORE the new image serves, so the column exists first).
--
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.

ALTER TABLE "order_contact_attempts"
  ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER;
