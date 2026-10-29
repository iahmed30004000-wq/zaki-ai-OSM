import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { PERMISSION_MODULES, withoutRetired } from '@/lib/permission-catalog';
import { isReservedRoleName } from '@/lib/role-names';
import { granterHoldsAll, newOrphanRefusal, orphanResponse, roleScopeRefusal } from '@/lib/user-permissions';

// Allowed canonical keys — built from the UI catalog (single source of truth).
const ALLOWED_KEYS: Set<string> = new Set(
  PERMISSION_MODULES.flatMap((m) => m.items.map((i) => i.key))
);

const VALID_SCOPES = ['ALL_COMPANY', 'OWN', 'ASSIGNED', 'CATEGORY', 'SPECIFIC'];

interface PermInput {
  permission: string;
  scope?: string;
  scopeIds?: unknown;
}

/**
 * GET /api/roles — list system roles (companyId: null) + the admin's company
 * roles, each with users count and its permission rows. Requires roles.view.
 */
export async function GET() {
  try {
    const admin = await requirePermission('roles.view');

    const where = admin.companyId
      ? { OR: [{ companyId: null }, { companyId: admin.companyId }] }
      : { companyId: null };

    const roles = await db.role.findMany({
      where,
      include: { permissions: { select: { permission: true, scope: true, scopeIds: true } } },
      orderBy: [{ companyId: 'asc' }, { createdAt: 'asc' }],
    });

    // Efficient users-count: one grouped query over all role ids.
    const roleIds = roles.map((r) => r.id);
    const counts = roleIds.length
      ? await db.user.groupBy({
          by: ['roleId'],
          where: { roleId: { in: roleIds } },
          _count: { _all: true },
        })
      : [];
    const countMap = new Map(counts.map((c) => [c.roleId, c._count._all]));

    return NextResponse.json({
      roles: roles.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        name: r.name,
        isSystem: r.isSystem,
        createdAt: r.createdAt,
        // The version a save is made over (the role editor sends it back; the door refuses a stale one).
        updatedAt: r.updatedAt,
        usersCount: countMap.get(r.id) ?? 0,
        permissionsCount: r.permissions.length,
        permissions: r.permissions.map((p) => ({
          permission: p.permission,
          scope: p.scope,
          scopeIds: p.scopeIds ?? null,
        })),
      })),
    });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/**
 * POST /api/roles — create a role with its permission matrix. Requires roles.create.
 * Company admins are forced to their own companyId; SUPER_ADMIN (platform,
 * companyId: null) must pass an explicit companyId which is verified server-side.
 */
export async function POST(req: Request) {
  try {
    const admin = await requirePermission('roles.create');
    const body = await req.json();
    const name: unknown = body?.name;
    const requestedCompanyId: unknown = body?.companyId;
    // A key the catalog has stopped offering is dropped before anything judges the list (none is retired yet).
    const permissions: PermInput[] = withoutRetired(Array.isArray(body?.permissions) ? (body.permissions as PermInput[]) : []);

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'اسم الدور مطلوب' }, { status: 400 });
    }

    // Reserved-name guard: system/privileged legacy role strings are never
    // creatable as company roles — a role named SUPER_ADMIN would let the
    // role-deletion replacement (or assignment) write the legacy string
    // 'SUPER_ADMIN' onto users, which the engine treats as fullAccess.
    if (isReservedRoleName(name) && admin.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'اسم الدور محجوز للنظام' }, { status: 403 });
    }

    // Validate permission keys against the catalog + scope integrity.
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

    // A new role is all NEW: an action without the key that opens its screen is refused.
    const orphan = newOrphanRefusal(permissions.map((p) => p.permission));
    if (orphan) return orphanResponse(orphan);

    // Granter-must-hold (same rule as PATCH): a created role must never carry
    // keys/scope-strengths the actor does not hold — the role could otherwise
    // be assigned to anyone (incl. via role-deletion replacement).
    const grantError = granterHoldsAll(admin, permissions.map((p) => ({ permission: p.permission, scope: p.scope ?? 'ALL_COMPANY', scopeIds: p.scopeIds })));
    if (grantError) {
      return NextResponse.json({ error: grantError }, { status: 403 });
    }

    // Tenant resolution — never trust client companyId blindly.
    let companyId: string | null;
    if (admin.companyId) {
      companyId = admin.companyId; // company admins are always tenant-bound
    } else if (admin.role === 'SUPER_ADMIN') {
      if (typeof requestedCompanyId !== 'string' || !requestedCompanyId) {
        return NextResponse.json({ error: 'يجب تحديد الشركة المستهدفة' }, { status: 400 });
      }
      const company = await db.company.findUnique({ where: { id: requestedCompanyId }, select: { id: true } });
      if (!company) {
        return NextResponse.json({ error: 'الشركة غير موجودة' }, { status: 400 });
      }
      companyId = company.id;
    } else {
      return NextResponse.json({ error: 'غير مسموح' }, { status: 403 });
    }

    // The ids in a CATEGORY/SPECIFIC scope are this company's, and the scope is one the key offers.
    const scopeRefusal = await roleScopeRefusal(companyId, permissions);
    if (scopeRefusal) return NextResponse.json({ error: scopeRefusal }, { status: 400 });

    const duplicate = await db.role.findFirst({ where: { companyId, name: name.trim() }, select: { id: true } });
    if (duplicate) {
      return NextResponse.json({ error: 'يوجد دور بنفس الاسم' }, { status: 409 });
    }

    const role = await db.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          companyId,
          name: name.trim(),
          isSystem: false,
          permissions: {
            create: permissions.map((p) => ({
              permission: p.permission,
              scope: p.scope ?? 'ALL_COMPANY',
              scopeIds: (p.scopeIds as unknown) ?? undefined,
            })),
          },
          // The matrix it was issued with, kept apart from the editable rows
          // so "restore defaults" has something honest to return to later.
          defaults: {
            create: permissions.map((p) => ({
              permission: p.permission,
              scope: p.scope ?? 'ALL_COMPANY',
              scopeIds: (p.scopeIds as unknown) ?? undefined,
            })),
          },
        },
        include: { permissions: true },
      });
      return created;
    });

    await logAudit({
      companyId: companyId ?? 'platform',
      userId: admin.id,
      action: 'ROLE_CREATED',
      entity: 'Role',
      entityId: role.id,
      previousData: null,
      newData: { name: role.name, companyId: role.companyId, permissions: role.permissions.map((p) => ({ permission: p.permission, scope: p.scope })) },
    });

    return NextResponse.json({ success: true, role }, { status: 201 });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
