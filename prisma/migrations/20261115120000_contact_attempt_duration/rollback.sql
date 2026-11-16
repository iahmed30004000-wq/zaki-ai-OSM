-- Rollback of 20261115120000_contact_attempt_duration.
--
-- Run ONLY after the previous release is redeployed: the generated client of this release selects "durationSeconds" on every OrderContactAttempt read, so dropping
-- the column under it would fail those reads. What is lost: the recorded durations only (call_helper_readings is untouched; nothing else reads the column).

ALTER TABLE "order_contact_attempts"
  DROP COLUMN IF EXISTS "durationSeconds";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115120000_contact_attempt_duration';
