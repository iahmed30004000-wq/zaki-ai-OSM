-- Rollback for 20261030140000_confirmation_split_keys.
-- Run ONLY after the code that asks for the new keys is reverted: with the code in place, removing these rows closes the
-- win-back offer, the hand-back of a colleague's postponed order, raising and correcting an entry issue, the whole
-- change-request desk, the packing table's decision, and the decision on a request that moves a figure — to everybody
-- (the orders themselves keep working; only those actions go).
-- Removes only the rows that migration wrote (ids starting with 'cs7-'), in all three places a grant lives. That includes
-- the orders.change_price rows it gave to deciders who hold no orders.edit, and the customers.view_basic rows it gave to
-- holders of customers.view: those people go back to exactly the keys they held before.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'cs7-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'cs7-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'cs7-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030140000_confirmation_split_keys';
