-- Rollback for 20261116120000_team_leader_role.
-- Run ONLY when nobody holds the role: a person assigned TEAM_LEADER keeps users.role = 'TEAM_LEADER' and, with the template gone, falls back to the in-code list (empty) and
-- loses every door. Reassign them first (PATCH /api/users/[id] action=assignRole) — the role row is deleted below ONLY if no user points at it.
-- Removes only the grant rows that migration wrote (ids starting with 'th12-'), in both places a grant lives. A row the owner saved again since then has a new id and is his.
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'th12-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'th12-%';
DELETE FROM "roles" r
WHERE r."companyId" IS NULL AND r.name = 'TEAM_LEADER'
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."roleId" = r.id OR u."role" = 'TEAM_LEADER')
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."roleId" = r.id);
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261116120000_team_leader_role';
