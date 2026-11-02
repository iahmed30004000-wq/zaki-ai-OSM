-- Rollback for 20261102120000_edit_confirmed_before_batch.
-- Run ONLY after the code that asks for orders.edit_confirmed is reverted: with the code in place, removing these rows takes
-- the holder's own window away from everybody — a change on a confirmed order goes back to being a request somebody else
-- decides (nothing is lost, and nothing already applied is undone).
-- Removes only the rows that migration wrote (ids starting with 'edc-'), in all three places a grant lives.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'edc-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'edc-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'edc-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261102120000_edit_confirmed_before_batch';
