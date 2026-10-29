-- Rollback for 20261029140000_settings_split_keys.
-- Run ONLY after the code that asks for the ten new keys is reverted: with the code in place, removing these rows
-- closes the jobs, the message templates, the penalty and performance rules, the offer rules, the commission page,
-- the delivery fees, the pixels and the migration of past orders to everybody.
-- Removes only the rows that migration wrote (ids starting with 'sp4-'), in all three places a grant lives.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'sp4-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'sp4-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'sp4-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029140000_settings_split_keys';
