import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { PERMISSION_MODULES, withoutRetired } from '@/lib/permission-catalog';
import { isReservedRoleName, isPrivilegedRoleName, normalizeRoleName } from '@/lib/role-names';
import {
  granterHoldsAll, canConferRole, roleScopeRefusal, newOrphanRefusal, orphanResponse,
  StalePermissionsError, roleVersionIsCurrent, staleResponse,
} from '@/lib/user-permissions';

const ALLOWED_KEYS: Set<string> = new Set(
  PERMISSION_MODULES.flatMap((m) => m.items.map((i) => i.key))
);

const VALID_SCOPES = ['ALL_COMPANY', 'OWN', 'ASSIGNED', 'CATEGORY', 'SPECIFIC'];

interface PermInput {
  permission: string;
  scope?: string;
  scopeIds?: unknown;
}

/** Tenant/read rule: system roles readable by all; company roles only same company. */
async function loadVisibleRole(id: string, adminCompanyId: string | null) {
  const role = await db.role.findUnique({
    where: { id },
    include: { permissions: { select: { permission: true, scope: true, scopeIds: true } } },
  });
  if (!role) return null;
  if (role.companyId !== null && role.companyId !== adminCompanyId) return null;
  return role;
}

function validatePermissions(permissions: PermInput[]): NextResponse | null {
  const seen = new Set<string>();
  for (const p of permissions) {
    if (typeof p?.permission !== 'string' || !ALLOWED_KEYS.has(p.permission)) {
      return NextResponse.json({ error: `صلاحية غير معروفة: ${p?.permission ?? ''}` }, { status: 400 });
    }
    if (seen.has(p.permission)) {
      return NextResponse.json({ error: `صلاحية مكررة: ${p.permission}` }, { status: 400 });
    }
    seen.add(p.permission);
    const scope = p.scope ?? 'ALL_COMPANY';
    if (!VALID_SCOPES.includes(scope)) {
      return NextResponse.json({ error: `نطاق غير صالح للصلاحية: ${p.permission}` }, { status: 400 });
    }
  }
  return null;
}

/** GET /api/roles/:id — single role with its permission matrix. Requires roles.view. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePermission('roles.view');
    const { id } = await params;
    const role = await loadVisibleRole(id, admin.companyId);
    if (!role) {
      return NextResponse.json({ error: 'الدور غير موجود' }, { status: 404 });
    }
    return NextResponse.json({ role });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/**
 * PATCH /api/roles/:id — rename and/or replace the permission matrix.
 * Requires roles.edit. System roles are editable only by COMPANY_ADMIN /
 * SUPER_ADMIN. The SUPER_ADMIN role is read-only by design.
 * All affected users get permissionsVersion bumped so grants recompute.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePermission('roles.edit');
    const { id } = await params;
    const body = await req.json();
    const name: unknown = body?.name;
    // A key the catalog has stopped offering is dropped before anything judges the list (none is retired yet).
    // A rename-only save (no list) stays possible.
    const permissions: PermInput[] | undefined = Array.isArray(body?.permissions) ? withoutRetired(body.permissions as PermInput[]) : undefined;

    // Policy: system roles are editable only by COMPANY_ADMIN / SUPER_ADMIN.
    const adminCanEditSystem = admin.role === 'SUPER_ADMIN' || admin.role === 'COMPANY_ADMIN';

    const role = await loadVisibleRole(id, admin.companyId);
    if (!role) {
      return NextResponse.json({ error: 'الدور غير موجود' }, { status: 404 });
    }

    if (role.isSystem && !adminCanEditSystem) {
      return NextResponse.json({ error: 'فقط مدير الشركة أو المدير الأعلى يمكنه تعديل الأدوار النظامية' }, { status: 403 });
    }

    // SUPER_ADMIN role is full-access by design — nothing to change, ever.
    if (normalizeRoleName(role.name) === normalizeRoleName('SUPER_ADMIN') && (name !== undefined || permissions !== undefined)) {
      return NextResponse.json({ error: 'Forbidden: SUPER_ADMIN is full-access by design', errorAr: 'دور مدير النظام مفتوحٌ بالتصميم — لا تُعدّل صلاحيّاتُه. استعمل دوراً أخر لمن تريد تقييده.' }, { status: 403 });
    }

    // Reserved-name guard: no role may be RENAMED into a system/privileged
    // legacy string (same rule as POST) — a rename to 'SUPER_ADMIN' would
    // grant fullAccess to every user bound to it via the legacy string.
    if (typeof name === 'string' && isReservedRoleName(name) && admin.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'اسم الدور محجوز للنظام' }, { status: 403 });
    }

    if (permissions) {
      const invalid = validatePermissions(permissions);
      if (invalid) return invalid;
      // Only an orphan this save ADDS is refused — the role's own old ones (5 shipped templates hold one) still save.
      const orphan = newOrphanRefusal(permissions.map((p) => p.permission), role.permissions.map((p) => p.permission));
      if (orphan) return orphanResponse(orphan);
      // Granter-must-hold: the actor may never place a key (or a stronger
      // scope) into ANY role — their own role or someone else's — that they
      // do not themselves hold. Blocks self-escalation via the role matrix
      // and cross-user conferral alike. Runs BEFORE any DB write.
      const grantError = granterHoldsAll(admin, permissions.map((p) => ({ permission: p.permission, scope: p.scope ?? 'ALL_COMPANY', scopeIds: p.scopeIds })));
      if (grantError) {
        return NextResponse.json({ error: grantError }, { status: 403 });
      }
      /*
       * AND THE ROLE AS IT STANDS, BEFORE IT IS REWRITTEN.
       *
       * Every account bound to the role gets what it is saved with. Checking
       * only the new matrix let somebody who lacks a key save the role
       * WITHOUT it — every save they could make removed it — and strip it
       * from every account on the role: the effect canActOnUser now stops on
       * one account at a time. You may rewrite a role only if you could have
       * given it as it is (canConferRole on its current rows).
       */
      const current = await canConferRole(admin, { id: role.id, name: role.name });
      if (!current.ok) return NextResponse.json({ error: current.error }, { status: current.status });
      // The ids are the ROLE's company's, and the scope is one the key offers —
      // for what is NEW in this save; a row already on the role is not re-judged.
      const scopeRefusal = await roleScopeRefusal(role.companyId ?? admin.companyId ?? null, permissions, role.permissions);
      if (scopeRefusal) return NextResponse.json({ error: scopeRefusal }, { status: 400 });
      // The list REPLACES the stored one: it is saved only over the version it was read from.
      if (!roleVersionIsCurrent(body?.version, role.updatedAt)) return staleResponse();
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return NextResponse.json({ error: 'اسم الدور غير صالح' }, { status: 400 });
    }

    const previousData = {
      name: role.name,
      permissions: role.permissions.map((p) => ({ permission: p.permission, scope: p.scope, scopeIds: p.scopeIds })),
    };

    const updated = await db.$transaction(async (tx) => {
      if (permissions) {
        // Taken in the same transaction that writes: two saves of one version cannot both win.
        const claimed = await tx.role.updateMany({ where: { id, updatedAt: role.updatedAt }, data: { updatedAt: new Date() } });
        if (claimed.count !== 1) throw new StalePermissionsError();
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (permissions.length) {
          await tx.rolePermission.createMany({
            data: permissions.map((p) => ({
              roleId: id,
              permission: p.permission,
              scope: p.scope ?? 'ALL_COMPANY',
              scopeIds: (p.scopeIds as unknown) ?? undefined,
            })),
          });
        }
      }
      const r = await tx.role.update({
        where: { id },
        data: name !== undefined ? { name: name.trim() } : {},
        include: { permissions: { select: { permission: true, scope: true, scopeIds: true } } },
      });
      // Invalidate cached grants: every bound user recomputes on next request.
      await tx.user.updateMany({ where: { roleId: id }, data: { permissionsVersion: { increment: 1 } } });
      return r;
    });

    await logAudit({
      companyId: role.companyId ?? admin.companyId ?? 'platform',
      userId: admin.id,
      action: 'ROLE_UPDATED',
      entity: 'Role',
      entityId: id,
      previousData,
      newData: {
        name: updated.name,
        permissions: updated.permissions.map((p) => ({ permission: p.permission, scope: p.scope, scopeIds: p.scopeIds })),
      },
    });

    return NextResponse.json({ success: true, role: updated });
  } catch (error: unknown) {
    if (error instanceof StalePermissionsError) return staleResponse();
    return apiErrorResponse(error);
  }
}

/**
 * DELETE /api/roles/:id — delete a company role. System roles are blocked.
 * Roles with bound users require ?replacementRoleId= to reassign them first
 * (each reassigned user gets permissionsVersion bumped).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePermission('roles.delete');
    const { id } = await params;

    const role = await loadVisibleRole(id, admin.companyId);
    if (!role) {
      return NextResponse.json({ error: 'الدور غير موجود' }, { status: 404 });
    }
    if (role.isSystem) {
      return NextResponse.json({ error: 'لا يمكن حذف الأدوار النظامية' }, { status: 403 });
    }

    const usersCount = await db.user.count({ where: { roleId: id } });

    if (usersCount > 0) {
      const replacementRoleId = new URL(req.url).searchParams.get('replacementRoleId');
      if (!replacementRoleId) {
        return NextResponse.json(
          { errorAr: `هذا الدور مرتبط بـ ${usersCount} مستخدم. اختر دورًا بديلًا.`, usersCount },
          { status: 400 }
        );
      }
      if (replacementRoleId === id) {
        return NextResponse.json({ error: 'الدور البديل يجب أن يختلف عن الدور المحذوف' }, { status: 400 });
      }
      const replacement = await loadVisibleRole(replacementRoleId, admin.companyId);
      if (!replacement) {
        return NextResponse.json({ error: 'الدور البديل غير موجود' }, { status: 400 });
      }
      // Privilege-escalation guard: the legacy role string written onto users
      // drives the permission engine — a replacement named SUPER_ADMIN (system
      // OR company role) would grant full platform access. The check is
      // name-based and normalization-safe on purpose: isSystem/companyId are
      // NOT sufficient identifiers for privileged legacy strings.
      if (isPrivilegedRoleName(replacement.name) && admin.role !== 'SUPER_ADMIN') {
        return NextResponse.json({ error: 'غير مسموح باستخدام دور المدير الأعلى كبديل' }, { status: 403 });
      }
      // Moving everybody off a role acts on every one of them: not by
      // somebody who could not have given that role (the same rule as
      // rewriting it, and as acting on one account).
      const leaving = await canConferRole(admin, { id: role.id, name: role.name });
      if (!leaving.ok) return NextResponse.json({ error: leaving.error }, { status: leaving.status });
      // Conferral policy: reassignment confers the replacement's full canonical
      // matrix onto every bound user — the actor must be able to grant it
      // (granter-must-hold). replacement.name is never a security authority.
      const conferral = await canConferRole(admin, { id: replacement.id, name: replacement.name });
      if (!conferral.ok) {
        return NextResponse.json({ error: conferral.error }, { status: conferral.status });
      }

      await db.$transaction(async (tx) => {
        // Reassign users + keep legacy role string in sync + invalidate grants.
        await tx.user.updateMany({
          where: { roleId: id },
          data: { roleId: replacementRoleId, role: replacement.name, permissionsVersion: { increment: 1 } },
        });
        await tx.role.delete({ where: { id } });
      });

      await logAudit({
        companyId: role.companyId ?? admin.companyId ?? 'platform',
        userId: admin.id,
        action: 'ROLE_DELETED',
        entity: 'Role',
        entityId: id,
        previousData: { name: role.name, usersReassigned: usersCount, replacementRole: replacement.name },
        newData: null,
      });

      return NextResponse.json({ success: true, usersReassigned: usersCount });
    }

    await db.role.delete({ where: { id } });
    await logAudit({
      companyId: role.companyId ?? admin.companyId ?? 'platform',
      userId: admin.id,
      action: 'ROLE_DELETED',
      entity: 'Role',
      entityId: id,
      previousData: { name: role.name },
      newData: null,
    });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
