-- Rollback for 20261111120000_wallet_pictures.
-- Run ONLY after the code and the generated client of this release are reverted: this release's wallet list and PATCH read and
-- write the three columns. Order: redeploy the old release, THEN run this file.
--
-- What is lost: the picture, the icon and the colour the owner chose for each wallet — every wallet goes back to the look its
-- currency and its id give it. The uploaded files stay on the uploads volume (nothing here deletes a file). Names, balances,
-- movements and transfers are not touched.
ALTER TABLE "wallets"
  DROP COLUMN IF EXISTS "image_key",
  DROP COLUMN IF EXISTS "icon_key",
  DROP COLUMN IF EXISTS "color_key";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111120000_wallet_pictures';
