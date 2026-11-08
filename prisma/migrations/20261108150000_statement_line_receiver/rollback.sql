-- Rollback for 20261108150000_statement_line_receiver.
-- Run ONLY after the code and the generated client of this release are reverted: this release's import writes the five
-- columns and its screens read them. Order: redeploy the old release, THEN run this file.
--
-- What is lost: the receiver's name, phone, address, governorate and area of every line imported by this release. The
-- raw row beside them still holds every cell the company wrote, so nothing the company said is lost — only which cell
-- was which. Matches, receipts, money and orders are not touched.
ALTER TABLE "statement_lines"
  DROP COLUMN IF EXISTS "receiverName",
  DROP COLUMN IF EXISTS "receiverPhone",
  DROP COLUMN IF EXISTS "receiverAddress",
  DROP COLUMN IF EXISTS "receiverCity",
  DROP COLUMN IF EXISTS "receiverArea";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108150000_statement_line_receiver';
