-- «رمز التفعيل» — the code the owner issues for somebody's first setup of the second factor (A2, PR-A).
--
-- TWO COLUMNS ON users, BOTH NULLABLE, NO DEFAULT, NO INDEX. The hash is the bcrypt hash of the code (the code itself is
-- shown to the owner once and never stored); the other is when it stops working. Every existing row reads null = «no code
-- was issued», which is exactly today's behaviour. Nothing is written, no row changes, and adding a nullable column with no
-- default is a catalogue change only in Postgres (no table rewrite), so it is instant on any table size.
--
-- THE CODE IS CHECKED ONLY WHILE AUTH_ENROL_CODE_REQUIRED=on. With the switch off (the default) no query of ours NAMES these
-- columns, and applying this file changes nothing about who can sign in.
--
-- BUT THE COLUMNS MUST EXIST BEFORE THE NEW CODE RUNS, SWITCH OR NO SWITCH. The generated Prisma client reads a User row with
-- every column it knows (getCurrentUser, the login, and about a hundred other reads take the whole row). Generate the client
-- from the new schema (postinstall, build) against a database that does not have these two columns, and EVERY session check
-- and EVERY sign-in fails. So the order is always: this file first, then `prisma generate` / build / start. On the server
-- docker-entrypoint.sh runs `prisma migrate deploy` before the server starts, which is that order. Locally apply it by hand
-- first. Code that runs BEFORE this file (the previous release) never names the columns, so the old release keeps working
-- on a database that already has them. For a local trial apply it by hand, never with `migrate dev`:
--   npx prisma db execute --file prisma/migrations/20261031000000_enrol_code/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261031000000_enrol_code
--
-- Additive only and idempotent (IF NOT EXISTS): running it twice changes nothing. Rollback: rollback.sql beside this file.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enrol_code_hash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enrol_code_expires_at" TIMESTAMP(3);
