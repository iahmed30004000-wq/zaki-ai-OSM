-- «صورة وأيقونة ولون لكل محفظة» — the owner, 11/11: «كل محفظة لازم تكون مميزة — ابحث عن صور عشان البنت تميزها بسرعة.»
--
-- THREE NEW NULLABLE COLUMNS ON ONE TABLE, NOTHING ELSE. No default, no NOT NULL, no index, no row written, no existing
-- column touched: in Postgres that is a catalogue change only, instant on a table of any size, and the code that ran before
-- it never reads or writes them. Hand-written; applied locally with `prisma db execute`, recorded with
-- `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261111120000_wallet_pictures/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261111120000_wallet_pictures
--
--   wallets.image_key — the storage key of the picture the owner uploaded for the wallet
--                       (companies/{company}/products/{wallet}/{uuid}.webp, served by /api/media). Written only by the
--                       wallet-picture door and the wallet PATCH, which accepts no key that door did not write.
--   wallets.icon_key  — one of the icons in src/lib/wallet-look.ts (WALLET_ICON_KEYS).
--   wallets.color_key — one of the colours in src/lib/wallet-look.ts (WALLET_COLOR_KEYS): a `--sys-*` variable of the theme.
--
-- A WALLET CREATED BEFORE THIS MIGRATION HAS NULL IN ALL THREE and looks the way it will look for as long as nobody chooses:
-- the icon its currency names and a colour picked from its id (`walletLook`). Nothing is backfilled.
--
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "image_key" TEXT,
  ADD COLUMN IF NOT EXISTS "icon_key"  TEXT,
  ADD COLUMN IF NOT EXISTS "color_key" TEXT;
