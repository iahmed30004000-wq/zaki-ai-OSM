-- Rollback of 20261118120000_integration_secrets.
-- Run ONLY after the previous release is redeployed: this release reads the table on every WhatsApp and Telegram call (and falls back to the environment if it cannot).
-- What is lost: the settings entered on the site (tokens, ids, secrets) — enter them in the environment again first, or the bots stop. No order, customer or conversation is lost.
DROP TABLE IF EXISTS "integration_secrets";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118120000_integration_secrets';
