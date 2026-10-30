-- Rollback for 20261030160000_ops_action_keys.
-- Run ONLY after the code that asks for the new keys is reverted: with the code in place, removing these rows closes the
-- shipping-batches page, the recording of a delivery outcome, the transfer of a parcel, the closing of a lost parcel and
-- the return fee — and the stand-down of a confirmed order for the people who reach it through the packing key — to
-- everybody (the orders themselves keep working; only those actions go).
-- Removes only the rows that migration wrote (ids starting with 'op8-'), in all three places a grant lives. That includes
-- the orders.cancel rows it gave to holders of ops.ship: those people go back to exactly the keys they held before.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'op8-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'op8-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'op8-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030160000_ops_action_keys';
