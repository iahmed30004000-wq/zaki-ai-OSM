-- «طلب تبديل» — the owner, 13/11, over a line of «فرق في المبلغ» whose parcel had no price to collect: «احيانا بيكون طلب تبديل او زبون
-- وصلو الطلب ناقص فنبعثلو حبة فلازم يا تعمل خيار يعطيك انو طلب تبديل». A difference at matching may now be answered as an exchange: for the
-- MONEY it is exactly «اعتُمد رقم الشركة» (the stored `resolution` stays ACCEPTED_COURIER, so no money path reads anything new), and it
-- carries a qualifier that says WHY — so the line is not counted as a discount somebody gave, and nobody is asked to carry its shortfall.
-- This is the ONE column the feature needs:
--
--   settlement_matches.resolutionKind
--       `EXCHANGE` beside `resolution = 'ACCEPTED_COURIER'` is «طلب تبديل». Null on every row written before this migration and on every
--       answer that is not an exchange. Written by every door that writes an answer (the single door, the bulk door), so a new answer
--       over an exchange clears it. Nothing reads it but the close (to leave the line out of the shortfall), the per-person tally and
--       the matching screen.
--
-- ONE NEW NULLABLE COLUMN ON ONE TABLE, NOTHING ELSE. No default, no NOT NULL, no index, no backfill, no row written, no existing
-- column touched: in Postgres that is a catalogue change only, instant on a table of any size, and the code that ran before it never
-- reads or writes the column. Every existing row stays NULL and keeps working exactly as it did. Hand-written; applied locally with
-- `prisma db execute`, recorded with `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's
-- Redeploy:
--   npx prisma db execute --file prisma/migrations/20261113040000_settlement_match_exchange_kind/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261113040000_settlement_match_exchange_kind
--
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.

ALTER TABLE "settlement_matches"
  ADD COLUMN IF NOT EXISTS "resolutionKind" TEXT;
