-- Rollback for 20261030120000_ai_assist_key.
-- Run ONLY after the code that asks for ai.assist is reverted: with the code in place, removing these rows closes the
-- confirmation assistant, the picking assistant, the landing-page writer, the AI step of order entry and «لخّصلي اليوم»
-- to everybody (the work itself keeps working; only the helpers inside it go).
-- Removes only the rows that migration wrote (ids starting with 'aia-'), in all three places a grant lives.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'aia-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'aia-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'aia-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030120000_ai_assist_key';
