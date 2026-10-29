-- Rollback for 20261029130000_analytics_view_becomes_reports_view.
-- Run ONLY after the code that removed the analytics.view alias is reverted:
-- without the alias, these rows are what keeps the dashboard and report doors open
-- for the people who held «عرض التحليلات».
-- Removes only the rows that migration wrote (ids starting with 'av2rv-').
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'av2rv-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'av2rv-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'av2rv-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029130000_analytics_view_becomes_reports_view';
