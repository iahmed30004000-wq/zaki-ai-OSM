-- Rollback for 20261031000000_enrol_code.
-- Run ONLY after the code that reads and writes the columns is reverted (src/lib/enrol-code.ts and the doors that call it:
-- /api/auth/2fa/start, /api/auth/2fa/enrol, /api/users/:id/enrol-code): with that code in place, dropping the columns makes
-- the first-time setup of the second factor fail on its first read.
--
-- The columns hold a one-time code's bcrypt hash and its expiry, nothing else, and every code expires within a day, so
-- dropping them loses nothing that cannot be issued again. Nobody's second factor, password or session is touched.
ALTER TABLE "users" DROP COLUMN IF EXISTS "enrol_code_hash";
ALTER TABLE "users" DROP COLUMN IF EXISTS "enrol_code_expires_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261031000000_enrol_code';
