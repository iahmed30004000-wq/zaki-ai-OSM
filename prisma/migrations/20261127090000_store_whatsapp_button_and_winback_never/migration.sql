-- Additive only: four new nullable/defaulted columns. No row is rewritten.
--
-- stores: which way the shop's WhatsApp button opens, picked in the store's settings. The default keeps every store exactly
-- as it was (EXTERNAL with no number = the support phone, as before).
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "whatsappMode" TEXT NOT NULL DEFAULT 'EXTERNAL';
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT;

-- customers: «إلغاء نهائي» on the win-back list — once set, the customer is never offered for win-back again.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "winbackNeverAt" TIMESTAMP(3);
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "winbackNeverById" TEXT;
