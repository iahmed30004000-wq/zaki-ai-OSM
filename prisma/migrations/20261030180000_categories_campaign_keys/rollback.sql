-- Rollback for 20261030180000_categories_campaign_keys.
-- Run ONLY after the code that asks for the three new keys is reverted: with the code in place, removing these rows closes
-- the campaigns screen and every campaign write (the two pulls from the ad platforms included), and the writes to the
-- categories, to everybody (the reports board and the products keep working; only those doors go).
-- Removes only the rows that migration wrote (ids starting with 'cc11-'), in all three places a grant lives. That includes
-- the «منع» rows it carried for people who did not pass a door. A row the owner saved again since then has a new id and is
-- his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'cc11-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'cc11-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'cc11-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030180000_categories_campaign_keys';
