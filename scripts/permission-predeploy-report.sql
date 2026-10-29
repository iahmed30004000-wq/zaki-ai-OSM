-- ═══════════════════════════════════════════════════════════════════════
-- PRE-DEPLOY REPORT — READ ONLY. Which roles hold an action without the key
-- that opens its screen, TODAY?
--
--   psql "$DATABASE_URL" -f scripts/permission-predeploy-report.sql
--
-- It only SELECTs: nothing is written, nothing is created (no temp object
-- either). The pairs are the catalog's `requires` (src/lib/permission-catalog.ts);
-- `src/lib/permission-model.test.ts` fails if this list drifts from it.
--
-- WHAT THE ANSWER MEANS. A row here is an old pair: the role keeps working and
-- keeps saving (the doors refuse only a pair a save ADDS). The measured result
-- on the local database was one pair — customers.view without
-- customers.view_basic — on the shipped COMPANY_ADMIN, MANAGER, MODERATOR,
-- DELIVERY_MANAGER and SUPER_ADMIN templates (SUPER_ADMIN's rows have no effect).
-- ═══════════════════════════════════════════════════════════════════════

WITH req(action, needs) AS (VALUES
  ('orders.edit','orders.view'),
  ('orders.import','orders.create'),
  ('orders.contact_log','orders.view'),
  ('orders.navigate','orders.view'),
  ('orders.assign','orders.view'),
  ('orders.claim','orders.view'),
  ('orders.release','orders.view'),
  ('orders.unlock','orders.view'),
  ('orders.confirm','orders.view'),
  ('orders.change_status','orders.view'),
  ('customers.view','customers.view_basic'),
  ('products.edit','products.view'),
  ('products.create','products.view'),
  ('products.delete','products.view'),
  ('products.change_price','products.view'),
  ('products.upload_images','products.view'),
  ('offers.manage','offers.view'),
  ('inventory.adjust','inventory.view'),
  ('production.manage','production.view'),
  ('finance.create','finance.view'),
  ('finance.update','finance.view'),
  ('settlement.upload','settlement.view'),
  ('settlement.review','settlement.view'),
  ('reports.export','orders.view'),
  ('users.create','users.view'),
  ('users.edit','users.view'),
  ('roles.create','roles.view'),
  ('roles.edit','roles.view'),
  ('roles.delete','roles.view'),
  ('settings.edit','settings.view'),
  ('settings.manage','settings.view'),
  ('confirmation.pull','confirmation.work'),
  ('payroll.pay','payroll.view'),
  ('penalties.decide','penalties.view'),
  ('apps.manage','apps.view'),
  ('geo.manage','geo.view'),
  ('storefront.manage','storefront.view'),
  ('storefront.publish','storefront.view'),
  ('storefront.domain','storefront.view'),
  ('landing_pages.create','landing_pages.view'),
  ('landing_pages.edit','landing_pages.view'),
  ('landing_pages.delete','landing_pages.view'),
  ('landing_pages.publish','landing_pages.view'),
  ('whatsapp.send','whatsapp.view'),
  ('whatsapp.manage','whatsapp.view'),
  ('whatsapp.assign','whatsapp.view'),
  ('telegram.manage','telegram.view'),
  ('orders.migrate','orders.import'),
  ('offers.rules','settings.view'),
  ('settings.jobs','settings.view'),
  ('settings.messages','settings.view'),
  ('settings.delivery_fees','settings.view'),
  ('settings.tracking','settings.view'),
  ('penalties.rules','settings.view'),
  ('team.settings','settings.view'),
  ('commission.manage','commission.view')
)
SELECT 'role_permissions' AS "table", r."name" AS "role", r."companyId", q.action, q.needs
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
JOIN req q ON q.action = rp."permission"
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" v WHERE v."roleId" = rp."roleId" AND v."permission" = q.needs
)
UNION ALL
SELECT 'role_permission_defaults', r."name", r."companyId", q.action, q.needs
FROM "role_permission_defaults" rp
JOIN "roles" r ON r."id" = rp."roleId"
JOIN req q ON q.action = rp."permission"
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permission_defaults" v WHERE v."roleId" = rp."roleId" AND v."permission" = q.needs
)
ORDER BY 1, 2, 4;

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE SECOND QUESTION (PR-5, ai.assist): WHICH ROLES WILL THE MIGRATION 20261030120000_ai_assist_key GIVE THE
-- «المساعدون الأذكياء» BOX TO? Every role that holds any key one of the five helpers asked before (the same five the
-- migration reads: src/lib/ai-assistants.ts AI_ASSIST_FROM). A role listed here keeps its helpers on the day; a role NOT
-- listed loses nothing, because it never reached one. `already_has_it` = rows the owner ticked before the deploy.
-- Read-only, same as above. After the deploy, the owner unticks the box from the roles that should not have a model
-- (orders.view is one of the five, so the list is long) — a «منع» on the box for one person does the same for one person.
-- ═══════════════════════════════════════════════════════════════════════
SELECT r."name" AS "role", r."companyId",
       array_agg(DISTINCT rp."permission" ORDER BY rp."permission") AS "reaches_a_helper_through",
       bool_or(EXISTS (SELECT 1 FROM "role_permissions" b WHERE b."roleId" = r."id" AND b."permission" = 'ai.assist')) AS "already_has_it"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
WHERE rp."permission" IN ('confirmation.work', 'ops.prepare', 'landing_pages.edit', 'orders.create', 'orders.view')
GROUP BY r."id", r."name", r."companyId"
ORDER BY 2 NULLS FIRST, 1;
