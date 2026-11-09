-- «تسوية السطور النظيفة عند الاعتماد» — the owner, 9/11: «طلبات بتاخد أسبوع تفسير». A statement's clean lines may settle their
-- orders at the approval instead of waiting for every line to be answered; a line still a question then holds only its own order.
-- The switch is the owner's and is OFF by default (Company.settings, no column). This is the ONE column the feature needs:
--
--   settlement_matches.appliedAt
--       the moment a CLEAN row (result MATCHED, with an order) had its order settled BEFORE the statement's matching closed.
--       Null on every row that was not — all of them while the switch is off, and every row of a statement closed the usual
--       way. A row that carries it is final: the close skips it (its order is already settled, and a second claim would stop
--       on «تغيّر وضع طلب»), and the matching, the answer doors, the hand link and the parcel swap leave it alone.
--
-- ONE NEW NULLABLE COLUMN ON ONE TABLE, NOTHING ELSE. No default, no NOT NULL, no index, no backfill, no row written, no
-- existing column touched: in Postgres that is a catalogue change only, instant on a table of any size, and the code that ran
-- before it never reads or writes the column. Every existing row stays NULL and keeps working exactly as it did. Hand-written;
-- applied locally with `prisma db execute`, recorded with `prisma migrate resolve --applied`, and in production by
-- `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261109200000_settlement_match_applied/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261109200000_settlement_match_applied
--
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.

ALTER TABLE "settlement_matches"
  ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3);
