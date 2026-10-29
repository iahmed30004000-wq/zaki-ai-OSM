-- «عرض التحليلات» (analytics.view) IS RETIRED: ITS HOLDERS KEEP EVERY DOOR IT OPENED.
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- Until now LEGACY_ALIAS sent every analytics.view check to reports.view as
-- well: «عرض التحليلات» and «عرض التقارير» were one door with two names. The
-- dashboard's API (/api/analytics and /loss), the performance board and the
-- campaigns all answered to either; a «منع» on the one did nothing while the
-- other stood. The alias line goes in the same change as this file; this file
-- makes sure NOBODY LOSES A DOOR when it does.
--
-- After this change all of those doors ask «عرض التقارير» (reports.view)
-- alone. So whoever passed them yesterday through analytics.view must hold
-- reports.view today:
--
--     analytics.view  ->  reports.view
--
-- in the three places a grant lives — the role, the role's «إرجاع للافتراضي»
-- baseline, and the person's own exception — with a «منع» carried across, so
-- nobody GAINS a door either. NOTHING is granted on dashboard.view: that key
-- opens the dashboard SCREEN and is held by nearly every role, and the owner's
-- ruling (28/10) is that the dashboard's numbers do not widen to all of them.
-- This file does NOT touch settings.manage (the sensitive-settings migration,
-- 20261027000000, is done and re-running its rule would re-grant what the
-- owner unticked since).
--
-- The one change in who passes, on purpose: a «منع» the owner ticked on
-- reports.view STARTS TO COUNT for a person whose role also held
-- analytics.view. It did nothing before, only because analytics.view stood
-- behind it. The owner ticked it; it counts. (The deploy report names who this
-- reaches.)
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING. No row is changed or
-- removed, so a role or a person who already holds reports.view keeps exactly
-- the row they had; the analytics.view rows stay, inert (the catalog no longer
-- offers the key, and the owner's next save of a role drops its row). Every
-- row written here has an id starting with 'av2rv-', which is how
-- rollback.sql finds them and nothing else.
--
-- THE ORDER MATTERS. The «منع» is carried FIRST, while the roles still show
-- who held reports.view before today: after the roles receive the key, «did
-- the role already hold it» would see the row just added, and a person denied
-- analytics.view would GAIN the doors (the 27/10 harness showed exactly that
-- on settings.manage). The person's «سماح» is carried LAST, after the roles,
-- so a role that received the key through this file does not also leave a
-- redundant exception behind that would outlive the owner unticking the role.
--
-- A person's role is read the way permissions-core reads it: their roleId, or
-- — with none — the system template named like their role. SUPER_ADMIN passes
-- everything anyway and gets no row.

-- 1. A «منع» on analytics.view becomes a «منع» on reports.view — but only for
--    a person whose role is about to receive reports.view (it holds
--    analytics.view and did not hold reports.view already) and who has no own
--    «سماح» on reports.view. A person denied analytics.view whose role also
--    holds reports.view passed yesterday through reports.view, and gets no row.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'av2rv-' || gen_random_uuid()::text, d."userId", 'reports.view', 'DENY', NULL, NULL, now()
FROM "user_permissions" d
JOIN "users" u ON u."id" = d."userId"
WHERE d."permission" = 'analytics.view'
  AND d."effect" = 'DENY'
  AND u."role" <> 'SUPER_ADMIN'
  AND EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "roles" r ON r."id" = rp."roleId"
    WHERE rp."permission" = 'analytics.view'
      AND ((u."roleId" IS NOT NULL AND r."id" = u."roleId")
        OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")))
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "roles" r ON r."id" = rp."roleId"
    WHERE rp."permission" = 'reports.view'
      AND ((u."roleId" IS NOT NULL AND r."id" = u."roleId")
        OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")))
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" x
    WHERE x."userId" = d."userId" AND x."permission" = 'reports.view' AND x."effect" = 'ALLOW')
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. Every role holding analytics.view — company roles AND the system
--    templates (companyId NULL), which every new company and every person
--    without a roleId reads — holds reports.view, with the same scope.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'av2rv-' || gen_random_uuid()::text, rp."roleId", 'reports.view', rp."scope", rp."scopeIds"
FROM "role_permissions" rp
WHERE rp."permission" = 'analytics.view'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. And in the baseline «إرجاع للافتراضي» restores, or the first reset after
--    this deploy would quietly take the doors away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'av2rv-' || gen_random_uuid()::text, d."roleId", 'reports.view', d."scope", d."scopeIds"
FROM "role_permission_defaults" d
WHERE d."permission" = 'analytics.view'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. A person's own «سماح» on analytics.view opened the same doors: it becomes
--    a «سماح» on reports.view, with the same scope — but only where their role
--    does not hold reports.view (after step 2), so a role that holds it leaves
--    no exception behind. A person who already has any exception on the key
--    keeps theirs.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'av2rv-' || gen_random_uuid()::text, a."userId", 'reports.view', 'ALLOW', a."scope", a."scopeIds", now()
FROM "user_permissions" a
JOIN "users" u ON u."id" = a."userId"
WHERE a."permission" = 'analytics.view'
  AND a."effect" = 'ALLOW'
  AND u."role" <> 'SUPER_ADMIN'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "roles" r ON r."id" = rp."roleId"
    WHERE rp."permission" = 'reports.view'
      AND ((u."roleId" IS NOT NULL AND r."id" = u."roleId")
        OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")))
ON CONFLICT ("userId", "permission") DO NOTHING;
