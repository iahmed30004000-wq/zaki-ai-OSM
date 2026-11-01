-- Rollback for 20261101120000_product_fixed_cost.
-- Run ONLY after the code of this release is reverted (an older release never names the table, so it keeps working with the table
-- there; a newer one that does cannot run without it). The table holds the figures an admin typed by hand — one per product — and
-- nothing else: dropping it loses them, and every product then costs what it did before this release (the weighted average). The
-- history of each change is in the audit log (`PRODUCT_FIXED_COST_SET`), which this does not touch.
DROP TABLE IF EXISTS "product_fixed_costs";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261101120000_product_fixed_cost';
