-- Rollback for 20261030190000_users_roles_apps_keys.
-- Run ONLY after the code that asks for the new keys is reverted: with the code in place, removing these rows takes the
-- deletion of an account, the moving of a colleague's shift, the setting of a password and the reset of a second factor, the
-- rewriting of a system role template and the issuing and stopping of a system key from EVERYBODY — except the owner
-- (SUPER_ADMIN), who passes every door centrally and is the way back in.
-- Removes only the rows that migration wrote (ids starting with 'ur13-'), in all three places a grant lives. Those people go
-- back to exactly the keys they held before.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'ur13-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'ur13-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'ur13-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030190000_users_roles_apps_keys';
