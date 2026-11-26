-- Rollback for 20261125180000_winback_private_list. Run ONLY after the previous release is redeployed (the code that reads these
-- columns no longer live). Idempotent. Every private win-back list is forgotten: its orders stay claimed by their agent as ordinary
-- held orders (back under her hand limit), and the «انعرض من قبل» mark of the expired ones is lost.
DROP INDEX IF EXISTS "orders_companyId_storeId_winbackListUserId_idx";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "winbackListSince";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "winbackListAt";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "winbackListUserId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261125180000_winback_private_list';
