-- أسطر الكشف تعرف لمن ذهب الطرد — the owner, 8/11, on a real Basha statement: «العنوان والمحافظة ورقم الهاتف والحالة»، و«زر المطابقة
-- عبر الهاتف مش شغال»، و«كيف بدي أقارن بين الطلب الموجود والطلب اللي عنا». BACKLOG_P2 RV762 named this column in advance.
--
-- FIVE NEW NULLABLE COLUMNS ON ONE TABLE, NOTHING ELSE. No default, no NOT NULL, no index, no row written, no existing
-- column touched: in Postgres that is a catalogue change only, instant on a table of any size, and the code that ran before
-- it never reads or writes them. Hand-written; applied locally with `prisma db execute`, recorded with
-- `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261108150000_statement_line_receiver/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261108150000_statement_line_receiver
--
--   statement_lines.receiverName / receiverPhone / receiverAddress / receiverCity / receiverArea
--       what the company's file wrote in the columns headed «اسم المستلم» / «هاتف المستلم» / «عنوان المستلم» /
--       «مدينة المستلم» / «منطقة المستلم» (and the English or shorter spellings the import knows). The raw row beside
--       them has no headings, so it could not say which cell was which.
--
-- A STATEMENT IMPORTED BEFORE THIS MIGRATION HAS NULL IN ALL FIVE and is read exactly as it always was (the raw row, the
-- first Syrian or Jordanian mobile in it). Nothing is backfilled: the file's bytes are not kept, only its hash, so the
-- headings of an old import cannot be recovered. An open, unapproved statement can be taken back and imported again.
--
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.

ALTER TABLE "statement_lines"
  ADD COLUMN IF NOT EXISTS "receiverName"    TEXT,
  ADD COLUMN IF NOT EXISTS "receiverPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "receiverAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "receiverCity"    TEXT,
  ADD COLUMN IF NOT EXISTS "receiverArea"    TEXT;
