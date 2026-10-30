-- Rollback for 20261031000000_enrol_code.
-- Run ONLY after the code and the generated client of this release are reverted. Dropping the columns while the new code is
-- still running breaks EVERY read of a User row, not just the setup of the second factor: the generated client selects all
-- the columns it knows, so every session check (getCurrentUser), every sign-in and every user list fails until the old
-- release (whose client does not know the columns) is running again. Order: redeploy the old release, THEN run this file.
--
-- The columns hold a one-time code's bcrypt hash and its expiry, nothing else, and every code expires within a day, so
-- dropping them loses nothing that cannot be issued again. Nobody's second factor, password or session is touched.
ALTER TABLE "users" DROP COLUMN IF EXISTS "enrol_code_hash";
ALTER TABLE "users" DROP COLUMN IF EXISTS "enrol_code_expires_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261031000000_enrol_code';
