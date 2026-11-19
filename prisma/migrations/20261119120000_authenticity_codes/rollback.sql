-- Rollback for 20261119120000_authenticity_codes. Run ONLY after the previous release is redeployed
-- (i.e. after the code that reads/writes "authenticity_codes" is no longer live) — otherwise the running
-- app errors on every call to the public verify endpoint and the admin screen.

DROP TABLE IF EXISTS "authenticity_codes";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119120000_authenticity_codes';
