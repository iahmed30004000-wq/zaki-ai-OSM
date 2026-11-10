-- Rollback for 20261110120000_telegram_upsell_products.
-- Run ONLY after the code and the generated client of this release are reverted: the Telegram door of this release reads
-- telegram_upsell_products. Order: redeploy the old release, THEN run this file.
--
-- What is lost: the «منتجات الأب سيل» names (added again from the screen). Orders already merged keep both their lines and
-- both their messages; nothing else in the database is touched.
DROP TABLE IF EXISTS "telegram_upsell_products";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261110120000_telegram_upsell_products';
