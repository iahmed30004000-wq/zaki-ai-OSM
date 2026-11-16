-- A LEAD FROM THE PAGES SYSTEM (Confirmation Center v2, step E1): one new table, additive only. No existing table, column, index or row is touched.
-- Idempotent on the pages system's own id: the unique key makes the same lead sent twice one row. Plain columns, no foreign keys — a record of what arrived.
CREATE TABLE IF NOT EXISTS "leads" (
  "id"            TEXT         NOT NULL,
  "companyId"     TEXT         NOT NULL,
  "storeId"       TEXT         NOT NULL,
  "externalId"    TEXT         NOT NULL,
  "fullName"      TEXT         NOT NULL,
  "phone"         TEXT         NOT NULL,
  "phoneKey"      TEXT         NOT NULL,
  "city"          TEXT,
  "productId"     TEXT         NOT NULL,
  "pageUrl"       TEXT,
  "utmCampaign"   TEXT,
  "utmContent"    TEXT,
  "status"        TEXT         NOT NULL DEFAULT 'NEW',
  "recentOrderId" TEXT,
  "receivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "leads_companyId_externalId_key" ON "leads"("companyId", "externalId");
CREATE INDEX IF NOT EXISTS "leads_companyId_storeId_status_receivedAt_idx" ON "leads"("companyId", "storeId", "status", "receivedAt");
CREATE INDEX IF NOT EXISTS "leads_companyId_phoneKey_idx" ON "leads"("companyId", "phoneKey");
