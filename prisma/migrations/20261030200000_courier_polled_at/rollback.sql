-- Rollback for 20261030200000_courier_polled_at.
-- Run ONLY after the code that reads and writes the column is reverted (the status poll in
-- src/lib/jobs/definitions/sync-courier-status.ts and src/lib/couriers/poll-stamp.ts): with that code in place, dropping
-- the column makes every sweep of the courier status job fail on the first read.
--
-- The column holds a bookkeeping stamp and nothing else — no status, no amount, no customer data — so dropping it loses
-- nothing that cannot be rebuilt: the next sweeps simply ask the parcels again, from the top, as the old in-memory cursor did.
ALTER TABLE "orders" DROP COLUMN IF EXISTS "courier_polled_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030200000_courier_polled_at';
