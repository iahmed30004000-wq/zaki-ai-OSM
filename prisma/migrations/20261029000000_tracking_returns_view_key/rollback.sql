-- Rollback for 20261029000000_tracking_returns_view_key.
-- Run ONLY after the code that asks for ops.returns_view is reverted: with the
-- code in place, removing these rows hides the return rows from everybody.
-- Removes only the rows that migration wrote (ids starting with 'trv-').
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'trv-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'trv-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'trv-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029000000_tracking_returns_view_key';
