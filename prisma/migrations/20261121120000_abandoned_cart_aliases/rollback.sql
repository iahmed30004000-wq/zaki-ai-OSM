-- Rollback for 20261121120000_abandoned_cart_aliases.
-- Run ONLY after the code and the generated client of this release are reverted: this release's landing door reads and
-- writes the table. Order: redeploy the old release, THEN run this file.
--
-- What is lost: which second-visit externalIds were folded into an existing cart. The carts themselves stay. After the
-- rollback, a re-send or a `/recovered` from Zaki pages under a folded externalId is unknown to the old door: a re-send makes
-- a new cart (as before this release), a `/recovered` answers 404. Nothing else in the database is touched.
DROP TABLE IF EXISTS "abandoned_cart_aliases";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121120000_abandoned_cart_aliases';
