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
  ('commission.manage','commission.view'),
  ('orders.change_price','orders.edit'),
  ('orders.change_fee','orders.change_status'),
  ('orders.cancel','orders.view'),
  ('orders.note','orders.view'),
  ('orders.request_change','orders.view'),
  ('orders.rating_link','orders.view'),
  ('control.blacklist_manage','control.blacklist'),
  ('confirmation.winback','confirmation.supervise'),
  ('confirmation.reassign','confirmation.supervise'),
  ('confirmation.issues_correct','confirmation.issues'),
  ('control.change_requests','control.change_requests_view'),
  -- PR-9. finance.cashbox needs finance.cashbox_view, which the migration 20261030150000 gives to every holder of it: so
  -- before that migration has run the pair is not reported (every cashier would be), after it, it is.
  ('finance.cashbox','finance.cashbox_view'),
  ('finance.wallets_manage','finance.cashbox_view'),
  ('finance.closing_approve','finance.cashbox_view'),
  ('settlement.approve','settlement.view'),
  -- PR-8. The operations boxes sit behind the tracking or the returns screen. The migration 20261030160000 gives each to the
  -- holders of the key it came from; ops.write_off also comes from two keys that need not come with ops.track, and those
  -- rows are the ones this reports (the box is inert for them: its only button is on the tracking screen).
  ('ops.deliver','ops.track'),
  ('ops.transfer','ops.track'),
  ('ops.write_off','ops.track'),
  ('ops.return_fee','ops.returns'),
  -- PR-11. Both keys come out of the migration 20261030180000_categories_campaign_keys together with their view, so before
  -- it has run neither is held by anybody (nothing is reported) and after it only an owner’s later unticking can show here.
  ('categories.manage','products.view'),
  ('campaigns.manage','campaigns.view'),
  -- PR-13. users.delete and users.shift ride behind users.edit (the profile's PATCH asks it first); the other three sit on their
  -- screen key. The migration 20261030190000 gives each to the holders of the old door, so a pair is reported only after it ran.
  ('users.delete','users.edit'),
  ('users.shift','users.edit'),
  ('users.security','users.view'),
  ('roles.edit_system','roles.edit'),
  ('apps.tokens','apps.view'),
  -- 30/10: the packing table's pen. Granted by no migration — a pair here would be a person the owner ticked it for who lost the screen key.
  ('ops.edit_in_batch','ops.batches'),
  -- 1/11: a product's fixed cost. Granted by no migration — a pair here would be a person the owner ticked it for who lost the edit key.
  ('products.change_cost','products.edit')
)
SELECT 'role_permissions' AS "table", r."name" AS "role", r."companyId", q.action, q.needs
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
JOIN req q ON q.action = rp."permission"
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" v WHERE v."roleId" = rp."roleId" AND v."permission" = q.needs
)
  AND (q.action <> 'finance.cashbox' OR EXISTS (
    SELECT 1 FROM "_prisma_migrations" m WHERE m."migration_name" = '20261030150000_finance_split_keys' AND m."finished_at" IS NOT NULL))
UNION ALL
SELECT 'role_permission_defaults', r."name", r."companyId", q.action, q.needs
FROM "role_permission_defaults" rp
JOIN "roles" r ON r."id" = rp."roleId"
JOIN req q ON q.action = rp."permission"
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permission_defaults" v WHERE v."roleId" = rp."roleId" AND v."permission" = q.needs
)
  AND (q.action <> 'finance.cashbox' OR EXISTS (
    SELECT 1 FROM "_prisma_migrations" m WHERE m."migration_name" = '20261030150000_finance_split_keys' AND m."finished_at" IS NOT NULL))
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

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE THIRD QUESTION (PR-6, the order actions): WHICH ROLES WILL THE MIGRATION 20261030130000_order_action_keys GIVE
-- EACH OF THE SEVEN BOXES TO? Every role that holds any key the box's door asked before (src/lib/order-action-keys.ts
-- ORDER_ACTION_KEYS_FROM, the same list the migration reads). A role listed here keeps its action on the day; the owner
-- unticks the box from the roles that should not have it afterwards. Read-only, same as above.
-- ═══════════════════════════════════════════════════════════════════════
SELECT k AS "box", r."name" AS "role", r."companyId", array_agg(DISTINCT rp."permission" ORDER BY rp."permission") AS "through"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
CROSS JOIN LATERAL unnest(CASE rp."permission"
  WHEN 'orders.edit' THEN ARRAY['orders.change_price']
  WHEN 'orders.change_status' THEN ARRAY['orders.change_fee']
  WHEN 'orders.unlock' THEN ARRAY['orders.cancel']
  WHEN 'orders.view' THEN ARRAY['orders.note', 'orders.request_change', 'orders.rating_link']
  WHEN 'confirmation.work' THEN ARRAY['orders.note', 'orders.request_change']
  WHEN 'control.blacklist' THEN ARRAY['control.blacklist_manage']
  ELSE ARRAY[]::text[]
END) AS k
GROUP BY k, r."id", r."name", r."companyId"
ORDER BY 1, 3 NULLS FIRST, 2;

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE FOURTH QUESTION (PR-9, the cash box and the statement approval): WHICH ROLES WILL THE MIGRATION
-- 20261030150000_finance_split_keys GIVE EACH OF THE FOUR BOXES TO, AND WILL THE BOX SIT WITHOUT ITS SCREEN KEY?
-- Every role that holds the key the box's door asked before (src/lib/finance-split-keys.ts FINANCE_SPLIT_KEYS_FROM, the
-- same list the migration reads). `without_its_view` = the role would hold the box but not the screen key it sits behind:
-- only settlement.approve can be that (a role that reviews matches without holding settlement.view — the view boxes of
-- the cash come from the same key as the actions). Such a role keeps its approval on the day; the owner ticks the view
-- for it or unticks the approval. Read-only, same as above.
-- ═══════════════════════════════════════════════════════════════════════
SELECT k AS "box", r."name" AS "role", r."companyId",
       (k = 'settlement.approve' AND NOT EXISTS (
         SELECT 1 FROM "role_permissions" v WHERE v."roleId" = r."id" AND v."permission" = 'settlement.view'
       )) AS "without_its_view"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
CROSS JOIN LATERAL unnest(CASE rp."permission"
  WHEN 'finance.cashbox' THEN ARRAY['finance.cashbox_view', 'finance.wallets_manage', 'finance.closing_approve']
  WHEN 'settlement.review' THEN ARRAY['settlement.approve']
  ELSE ARRAY[]::text[]
END) AS k
GROUP BY k, r."id", r."name", r."companyId"
ORDER BY 1, 3 NULLS FIRST, 2;

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE FIFTH QUESTION (PR-7, the confirmation and change-request doors): WHICH ROLES WILL THE MIGRATION
-- 20261030140000_confirmation_split_keys GIVE EACH BOX TO? Every role that holds any key the box's door asked before
-- (src/lib/confirmation-split-keys.ts CONFIRMATION_SPLIT_KEYS_FROM, the same list the migration reads). A role listed here
-- keeps its action on the day; the owner unticks the box from the roles that should not have it afterwards.
--
-- orders.change_price is listed only for a role WITHOUT orders.edit: those roles hold it as an "action without its view" on
-- purpose — they decide change requests today, and a request that moves a figure now needs the key. Read-only, same as above.
-- ═══════════════════════════════════════════════════════════════════════
SELECT k AS "box", r."name" AS "role", r."companyId", array_agg(DISTINCT rp."permission" ORDER BY rp."permission") AS "through"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
CROSS JOIN LATERAL unnest(CASE rp."permission"
  WHEN 'confirmation.supervise' THEN ARRAY['confirmation.winback', 'confirmation.reassign']
  WHEN 'confirmation.issues' THEN ARRAY['confirmation.issues_correct', 'confirmation.raise_issue']
  WHEN 'control.change_requests' THEN ARRAY['control.change_requests_view', 'orders.change_price']
  WHEN 'ops.ship' THEN ARRAY['ops.decide_changes', 'orders.change_price']
  WHEN 'confirmation.pull' THEN ARRAY['orders.change_price']
  WHEN 'confirmation.work' THEN ARRAY['orders.change_price']
  WHEN 'orders.claim' THEN ARRAY['orders.change_price']
  WHEN 'customers.view' THEN ARRAY['customers.view_basic']
  ELSE ARRAY[]::text[]
END) AS k
WHERE k <> 'orders.change_price'
   OR NOT EXISTS (SELECT 1 FROM "role_permissions" e WHERE e."roleId" = r."id" AND e."permission" = 'orders.edit')
GROUP BY k, r."id", r."name", r."companyId"
ORDER BY 1, 3 NULLS FIRST, 2;

-- The people who pass a door BY NAME and get its key from the migration: how many there are per role.
SELECT u."role" AS "role", count(*) AS "people"
FROM "users" u
WHERE u."role" IN ('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR', 'WAREHOUSE', 'CONFIRMATION_AGENT')
GROUP BY u."role"
ORDER BY 1;

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE SIXTH QUESTION (PR-8, the operations doors): WHICH ROLES WILL THE MIGRATION
-- 20261030160000_ops_action_keys GIVE EACH BOX TO? Every role that holds any key the box's door asked before
-- (src/lib/ops-action-keys.ts OPS_ACTION_KEYS_FROM, the same list the migration reads). Read-only, same as above.
--
-- `without_its_screen` = the role would hold the box but not the screen key it sits behind (ops.track for the three
-- tracking acts, ops.returns for the fee): only ops.write_off can be that, because finance.update and orders.unlock need not
-- come with ops.track. Such a role keeps its door on the day (the API), but the box is inert in practice: its only button is
-- on the tracking screen. The owner ticks the screen for it or unticks the box.
--
-- (The pairs in the first list above for these four boxes return nothing BEFORE the deploy: the boxes do not exist yet.)
-- ═══════════════════════════════════════════════════════════════════════
SELECT k AS "box", r."name" AS "role", r."companyId", array_agg(DISTINCT rp."permission" ORDER BY rp."permission") AS "through",
       (k = 'ops.write_off' AND NOT EXISTS (
         SELECT 1 FROM "role_permissions" v WHERE v."roleId" = r."id" AND v."permission" = 'ops.track'
       )) AS "without_its_screen"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
CROSS JOIN LATERAL unnest(CASE rp."permission"
  WHEN 'ops.ship' THEN ARRAY['ops.batches']
  WHEN 'ops.track' THEN ARRAY['ops.batches', 'ops.deliver', 'ops.transfer']
  WHEN 'finance.update' THEN ARRAY['ops.write_off']
  WHEN 'orders.unlock' THEN ARRAY['ops.write_off']
  WHEN 'ops.returns' THEN ARRAY['ops.return_fee']
  ELSE ARRAY[]::text[]
END) AS k
GROUP BY k, r."id", r."name", r."companyId"
ORDER BY 1, 3 NULLS FIRST, 2;

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE FIFTH QUESTION (PR-11, the categories and the campaigns): WHO GETS WHAT FROM THE MIGRATION
-- 20261030180000_categories_campaign_keys, AND WHO LOSES THE COMPANY'S SHELVES ON PURPOSE (D1m)?
-- Per role: the box, and the scope the role holds its source at. campaigns.view and campaigns.manage go to every role that holds
-- reports.view (the same list — the owner unticks from the checklist afterwards). categories.manage goes only to a role that
-- holds products.edit «كل الشركة»: a row with `receives = false` is a role whose product editors are narrower than that and
-- LOSE the company-wide writes to the categories on the day (it keeps the sorter onto existing shelves). Read-only, same as above.
-- ═══════════════════════════════════════════════════════════════════════
SELECT k AS "box", r."name" AS "role", r."companyId", rp."permission" AS "source", rp."scope",
       (k <> 'categories.manage' OR rp."scope" = 'ALL_COMPANY') AS "receives"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
CROSS JOIN LATERAL unnest(CASE rp."permission"
  WHEN 'products.edit' THEN ARRAY['categories.manage']
  WHEN 'reports.view' THEN ARRAY['campaigns.view', 'campaigns.manage']
  ELSE ARRAY[]::text[]
END) AS k
ORDER BY 1, 6, 3 NULLS FIRST, 2;

-- The people whose OWN «سماح» on products.edit is narrower than «كل الشركة» — they lose the shelves' writes whatever their role
-- gives, and the migration refuses them the box with a «منع».
SELECT u."id", u."name", u."role", up."scope"
FROM "user_permissions" up
JOIN "users" u ON u."id" = up."userId"
WHERE up."permission" = 'products.edit' AND up."effect" = 'ALLOW' AND COALESCE(up."scope", 'ALL_COMPANY') <> 'ALL_COMPANY'
ORDER BY 3, 2;

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE LAST QUESTION (PR-13, users, roles and app keys), in five parts. Read-only, same as above.
--
-- A. WHO ALREADY HOLDS ONE OF THE FIVE NEW KEYS TODAY? It must be NOBODY: the keys are new, and users.delete was pruned on
--    21/9. A row here would hand the door to people the migration never judged — fix it before the deploy.
-- ═══════════════════════════════════════════════════════════════════════
SELECT 'role' AS "kind", r."name" AS "who", r."companyId", rp."permission"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
WHERE rp."permission" IN ('users.delete', 'users.shift', 'users.security', 'roles.edit_system', 'apps.tokens')
UNION ALL
SELECT 'person', u."email", u."companyId", up."permission"
FROM "user_permissions" up
JOIN "users" u ON u."id" = up."userId"
WHERE up."permission" IN ('users.delete', 'users.shift', 'users.security', 'roles.edit_system', 'apps.tokens')
ORDER BY 1, 2;

-- B. WHICH ROLES THE MIGRATION GIVES EACH BOX TO. A role listed keeps its door on the day; the owner unticks afterwards.
--    users.security and roles.edit_system go to every role NAMED COMPANY_ADMIN (the owner, SUPER_ADMIN, needs no row).
SELECT k AS "box", r."name" AS "role", r."companyId"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
CROSS JOIN LATERAL unnest(CASE rp."permission"
  WHEN 'users.edit' THEN ARRAY['users.delete', 'users.shift']
  WHEN 'apps.manage' THEN ARRAY['apps.tokens']
  ELSE ARRAY[]::text[]
END) AS k
UNION
SELECT k, r."name", r."companyId"
FROM "roles" r
CROSS JOIN LATERAL unnest(ARRAY['users.security', 'roles.edit_system']) AS k
WHERE r."name" = 'COMPANY_ADMIN'
GROUP BY k, r."id", r."name", r."companyId"
ORDER BY 1, 3 NULLS FIRST, 2;

-- C. THE ONE DOOR THAT IS NARROWED ON PURPOSE (D9): personal exceptions move from users.edit to roles.edit, and the migration
--    does NOT hand roles.edit to profile editors. These roles hold users.edit WITHOUT roles.edit: their people lose the
--    «استثناءات الموظف» card on the day. How many people each, so the owner knows before the deploy.
SELECT r."name" AS "role", r."companyId", count(u."id") AS "people"
FROM "roles" r
JOIN "role_permissions" e ON e."roleId" = r."id" AND e."permission" = 'users.edit'
LEFT JOIN "users" u ON u."roleId" = r."id"
WHERE NOT EXISTS (SELECT 1 FROM "role_permissions" x WHERE x."roleId" = r."id" AND x."permission" = 'roles.edit')
GROUP BY r."id", r."name", r."companyId"
ORDER BY 3 DESC, 1;

-- D. THE INBOX NOW OBEYS THE STORED SCOPE (D1-i): a role whose whatsapp.view is saved at anything but the whole company sees
--    only the conversations assigned to it and the unassigned ones after the deploy. These roles, and their people.
SELECT r."name" AS "role", r."companyId", rp."scope", count(u."id") AS "people"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
LEFT JOIN "users" u ON u."roleId" = r."id"
WHERE rp."permission" = 'whatsapp.view' AND rp."scope" <> 'ALL_COMPANY'
GROUP BY r."id", r."name", r."companyId", rp."scope"
ORDER BY 4 DESC, 1;

-- E. LEFT FOR THE OWNER, NOT BACKFILLED: a role that manages WhatsApp or Telegram without being able to view it. The migration
--    does not give it the view (that would open a customer inbox to a role that never saw one).
SELECT r."name" AS "role", r."companyId", m."permission" AS "manages_without_view"
FROM "role_permissions" m
JOIN "roles" r ON r."id" = m."roleId"
WHERE m."permission" IN ('whatsapp.manage', 'telegram.manage')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" v
    WHERE v."roleId" = m."roleId"
      AND v."permission" = CASE m."permission" WHEN 'whatsapp.manage' THEN 'whatsapp.view' ELSE 'telegram.view' END)
ORDER BY 3, 1;

-- ═══════════════════════════════════════════════════════════════════════
-- AND THE QUESTION OF PR-10 ( cost, smart cards and the team's tables): WHICH ROLES WILL THE MIGRATION
-- 20261030170000_costs_insights_keys GIVE costs.view, insights.view AND team.monitor TO? Every role that holds any key the
-- door asked before (src/lib/visibility-keys.ts VISIBILITY_KEYS_FROM, the same list the migration reads), and the roles NAMED
-- COMPANY_ADMIN / MANAGER for team.monitor. A role listed here keeps its figures on the day; the owner unticks the box from
-- the roles that should not have it afterwards (D5: from a checklist, never inside a migration). Read-only, same as above.
-- ═══════════════════════════════════════════════════════════════════════
SELECT k AS "box", r."name" AS "role", r."companyId", array_agg(DISTINCT rp."permission" ORDER BY rp."permission") AS "through"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
CROSS JOIN LATERAL unnest(CASE rp."permission"
  WHEN 'inventory.view' THEN ARRAY['costs.view', 'insights.view']
  WHEN 'inventory.adjust' THEN ARRAY['costs.view']
  WHEN 'production.view' THEN ARRAY['costs.view']
  WHEN 'production.manage' THEN ARRAY['costs.view']
  WHEN 'finance.view' THEN ARRAY['costs.view']
  WHEN 'products.view' THEN ARRAY['insights.view']
  WHEN 'reports.view' THEN ARRAY['insights.view']
  WHEN 'dashboard.view' THEN ARRAY['insights.view']
  WHEN 'confirmation.work' THEN ARRAY['insights.view']
  WHEN 'orders.confirm' THEN ARRAY['insights.view']
  WHEN 'customers.view' THEN ARRAY['insights.view']
  WHEN 'orders.view' THEN ARRAY['insights.view']
  WHEN 'landing_pages.view' THEN ARRAY['insights.view']
  WHEN 'users.view' THEN ARRAY['team.monitor']
  ELSE ARRAY[]::text[]
END) AS k
GROUP BY k, r."id", r."name", r."companyId"
ORDER BY 1, 3 NULLS FIRST, 2;

-- The people who pass the team tables BY NAME and get team.monitor from the migration: how many there are per role.
SELECT u."role" AS "role", count(*) AS "people"
FROM "users" u
WHERE u."role" IN ('COMPANY_ADMIN', 'MANAGER')
GROUP BY u."role"
ORDER BY 1;

-- Who holds payroll.pay WITHOUT payroll.view (the catalogue says the first requires the second). The payslip preview now asks
-- BOTH, so each of these roles loses the preview until the owner ticks «عرض الرواتب» for it — the migration cannot do it
-- for them without opening the profile's pay and a colleague's owed commission to people who do not see them today.
SELECT r."name" AS "role", r."companyId"
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."roleId"
WHERE rp."permission" = 'payroll.pay'
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" v WHERE v."roleId" = rp."roleId" AND v."permission" = 'payroll.view')
ORDER BY 2 NULLS FIRST, 1;

-- …and the same for a PERSON: a personal «سماح» on payroll.pay with no payroll.view of their own (the role may give it).
-- The profile’s salary section was already drawn only with payroll.view, so none of them could reach the preview by a screen;
-- this lists who could still have called it.
SELECT u."email", u."role"
FROM "user_permissions" up
JOIN "users" u ON u."id" = up."userId"
WHERE up."permission" = 'payroll.pay' AND up."effect" = 'ALLOW'
  AND NOT EXISTS (SELECT 1 FROM "user_permissions" v WHERE v."userId" = up."userId" AND v."permission" = 'payroll.view' AND v."effect" = 'ALLOW')
ORDER BY 2, 1;

-- The one widening of PR-10 (see the migration header): who ALREADY holds team.monitor — by a role or by a personal «سماح» — and
-- will now also read the confirmation team tables through it. And the roles NAMED COMPANY_ADMIN / MANAGER that do not hold it
-- today: the migration gives it to them (the team tables were open to those names), which undoes an untick the owner may have made.
SELECT 'role holds team.monitor' AS "what", r."name" AS "who", r."companyId"
FROM "role_permissions" rp JOIN "roles" r ON r."id" = rp."roleId"
WHERE rp."permission" = 'team.monitor'
UNION ALL
SELECT 'person holds team.monitor', u."email", NULL
FROM "user_permissions" up JOIN "users" u ON u."id" = up."userId"
WHERE up."permission" = 'team.monitor' AND up."effect" = 'ALLOW'
UNION ALL
SELECT 'named role WITHOUT team.monitor (will receive it)', r."name", r."companyId"
FROM "roles" r
WHERE r."name" IN ('COMPANY_ADMIN', 'MANAGER')
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."roleId" = r."id" AND rp."permission" = 'team.monitor')
ORDER BY 1, 2;
