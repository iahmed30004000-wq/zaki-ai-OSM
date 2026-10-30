-- Rollback for 20261030160000_ops_action_keys.
-- Run ONLY after the code that asks for the new keys is reverted: with the code in place, removing these rows closes the
-- shipping-batches page, the recording of a delivery outcome, the transfer of a parcel, the closing of a lost parcel and
-- the return fee to everybody (the orders themselves keep working; only those actions go). The stand-down door is not part
-- of this migration and keeps asking ops.ship either way.
-- Removes only the rows that migration wrote (ids starting with 'op8-'), in all three places a grant lives; it wrote no row
-- for orders.cancel or ops.ship.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'op8-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'op8-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'op8-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030160000_ops_action_keys';
