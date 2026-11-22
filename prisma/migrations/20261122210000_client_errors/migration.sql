-- «ZAKI ORDERS» — WHAT WENT WRONG ON A PHONE (2026-11-22): crashes, frozen screens and caught errors the Android app
-- sends, for the manager to read. No customer data is ever stored here (see ClientError in schema.prisma).
CREATE TABLE "client_errors" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "screen" TEXT,
    "appVersion" TEXT NOT NULL,
    "versionCode" INTEGER,
    "device" TEXT,
    "osVersion" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_errors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_errors_companyId_createdAt_idx" ON "client_errors"("companyId", "createdAt");
CREATE INDEX "client_errors_companyId_kind_createdAt_idx" ON "client_errors"("companyId", "kind", "createdAt");
