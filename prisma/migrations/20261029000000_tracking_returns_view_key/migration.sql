-- «عرض المرتجعات في المتابعة» (ops.returns_view) — a NEW, VIEW-ONLY key.
--
-- On «متابعة الشحن» the return rows (طلب إرجاع، مرتجع) now need their own key.
-- «المرتجعات» (ops.returns) stays the key that RECEIVES the stock at the
-- desk; seeing the rows on the follow-up screen is a different decision, and
-- the owner takes it per role from «الصلاحيات».
--
-- NOBODY LOSES THE ROWS ON THE DAY. Until now every holder of ops.track saw
-- the return rows. The owner's default (28/10): the key goes to the roles
-- that already hold ops.returns, plus the delivery manager, in the three
-- places a grant lives — the role, the role's «إرجاع للافتراضي» baseline,
-- and the person's own exception — and he unticks it per role afterwards.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING. No row is changed or
-- removed, so a role or a person who already holds the key keeps exactly the
-- row they had. Every row written here has an id starting with 'trv-', which
-- is how rollback.sql finds them and nothing else.
--
-- A «منع» on ops.returns is NOT carried. It was a refusal to RECEIVE stock;
-- it never hid a row from the follow-up screen, so the person keeps the view
-- their role gives them.
--
-- THE BASELINE IS WRITTEN ONLY WHERE ONE EXISTS. «إرجاع للافتراضي» reads
-- role_permission_defaults, and a role with no rows there answers «no
-- baseline» — a lone row would turn that into a baseline holding this one
-- key, and restoring it would wipe the role. So the delivery manager's
-- baseline is touched only for a role that already has one.

-- 1. Every role holding ops.returns — company roles AND the system templates
--    (companyId NULL) — holds ops.returns_view, with the same scope.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'trv-' || gen_random_uuid()::text, rp."roleId", 'ops.returns_view', rp."scope", rp."scopeIds"
FROM "role_permissions" rp
WHERE rp."permission" = 'ops.returns'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 2. The delivery manager, in every company and in the template.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'trv-' || gen_random_uuid()::text, r."id", 'ops.returns_view', 'ALL_COMPANY', NULL
FROM "roles" r
WHERE r."name" = 'DELIVERY_MANAGER'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. A person's own «سماح» on ops.returns becomes a «سماح» on ops.returns_view,
--    with the same scope. SUPER_ADMIN passes everything anyway.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'trv-' || gen_random_uuid()::text, a."userId", 'ops.returns_view', 'ALLOW', a."scope", a."scopeIds", now()
FROM "user_permissions" a
JOIN "users" u ON u."id" = a."userId"
WHERE a."permission" = 'ops.returns'
  AND a."effect" = 'ALLOW'
  AND u."role" <> 'SUPER_ADMIN'
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 4. And in the baseline «إرجاع للافتراضي» restores, or the first reset after
--    this deploy would quietly take the key away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'trv-' || gen_random_uuid()::text, d."roleId", 'ops.returns_view', d."scope", d."scopeIds"
FROM "role_permission_defaults" d
WHERE d."permission" = 'ops.returns'
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'trv-' || gen_random_uuid()::text, r."id", 'ops.returns_view', 'ALL_COMPANY', NULL
FROM "roles" r
WHERE r."name" = 'DELIVERY_MANAGER'
  AND EXISTS (SELECT 1 FROM "role_permission_defaults" b WHERE b."roleId" = r."id")
ON CONFLICT ("roleId", "permission") DO NOTHING;
