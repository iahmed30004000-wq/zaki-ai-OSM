-- Rollback for 20261115120000_abandoned_carts.
-- Run ONLY after the code and the generated client of this release are reverted: this release's landing door, carts screen and
-- retention job read and write both tables. Order: redeploy the old release, THEN run this file.
--
-- What is lost: the abandoned carts Zaki pages sent and the team's work on them (statuses, attempts, notes, follow-up dates,
-- assignments). No order is lost: an order made from a cart is an ordinary order and only the cart pointed at it. Zaki pages
-- keeps its own copy of each lead for 30 days. Nothing else in the database is touched.
DROP TABLE IF EXISTS "abandoned_cart_activities";
DROP TABLE IF EXISTS "abandoned_carts";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115120000_abandoned_carts';
