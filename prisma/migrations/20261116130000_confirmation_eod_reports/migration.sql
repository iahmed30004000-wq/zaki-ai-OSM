-- THE TEAM LEADER'S END-OF-DAY REPORT (Confirmation Center v2, step H2): one new table, additive only. No existing table, column, index or row is touched.
-- Written once per (store, local day, person) and never edited: the unique key refuses a second submission. Plain columns, no foreign keys — a record, not part of another table's life.
CREATE TABLE IF NOT EXISTS "confirmation_eod_reports" (
  "id"          TEXT         NOT NULL,
  "companyId"   TEXT         NOT NULL,
  "storeId"     TEXT         NOT NULL,
  "day"         TEXT         NOT NULL,
  "userId"      TEXT         NOT NULL,
  "payload"     JSONB        NOT NULL,
  "system"      JSONB        NOT NULL,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "confirmation_eod_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "confirmation_eod_reports_companyId_storeId_day_userId_key" ON "confirmation_eod_reports"("companyId", "storeId", "day", "userId");
CREATE INDEX IF NOT EXISTS "confirmation_eod_reports_companyId_day_idx" ON "confirmation_eod_reports"("companyId", "day");
