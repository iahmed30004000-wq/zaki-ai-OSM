-- Rollback for 20261030150000_finance_split_keys.
-- Run ONLY after the code that asks for the four new keys is reverted: with the code in place, removing these rows closes
-- the wallets' screens, the creation and deletion of a wallet, the approval of a daily closing and the approval of a
-- courier statement to everybody (the cash movements and the matching keep working; only those doors go).
-- Removes only the rows that migration wrote (ids starting with 'fs9-'), in all three places a grant lives.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'fs9-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'fs9-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'fs9-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030150000_finance_split_keys';
