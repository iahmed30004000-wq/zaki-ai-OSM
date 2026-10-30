-- «رمز التفعيل» — the code the owner issues for somebody's first setup of the second factor (A2, PR-A).
--
-- TWO COLUMNS ON users, BOTH NULLABLE, NO DEFAULT, NO INDEX. The hash is the bcrypt hash of the code (the code itself is
-- shown to the owner once and never stored); the other is when it stops working. Every existing row reads null = «no code
-- was issued», which is exactly today's behaviour. Nothing is written, no row changes, and adding a nullable column with no
-- default is a catalogue change only in Postgres (no table rewrite), so it is instant on any table size.
--
-- THE CODE IS READ ONLY WHILE AUTH_ENROL_CODE_REQUIRED=on. With the switch off (the default) these columns are never read
-- by the sign-in, so applying this file changes nothing about who can sign in.
--
-- Code that runs BEFORE this file (the previous release) never names the columns, so it keeps working if this file is
-- applied first; code that runs AFTER it needs them. docker-entrypoint.sh runs `prisma migrate deploy` at every start,
-- before the server, so the columns arrive first. For a local trial apply it by hand, never with `migrate dev`:
--   npx prisma db execute --file prisma/migrations/20261031000000_enrol_code/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261031000000_enrol_code
--
-- Additive only and idempotent (IF NOT EXISTS): running it twice changes nothing. Rollback: rollback.sql beside this file.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enrol_code_hash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enrol_code_expires_at" TIMESTAMP(3);
