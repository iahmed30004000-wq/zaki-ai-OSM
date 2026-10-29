-- Rollback for 20261030130000_order_action_keys.
-- Run ONLY after the code that asks for the seven new keys is reverted: with the code in place, removing these rows closes
-- the price, the delivery fee, cancelling, the note, the change request, the review link and the blacklist's block and
-- release to everybody (the order itself keeps working; only those actions go).
-- Removes only the rows that migration wrote (ids starting with 'oa6-'), in all three places a grant lives.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'oa6-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'oa6-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'oa6-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030130000_order_action_keys';
