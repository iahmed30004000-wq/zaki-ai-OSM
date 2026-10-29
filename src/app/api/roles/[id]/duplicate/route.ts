import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { withoutRetired } from '@/lib/permission-catalog';
import { canConferRole, newOrphanRefusal, orphanResponse } from '@/lib/user-permissions';

/**
 * POST /api/roles/:id/duplicate — copy a role (name + ' (نسخة)') with its full
 * permission matrix incl. scopeIds. Requires roles.create. No users are bound.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePermission('roles.create');
    const { id } = await params;

    const source = await db.role.findUnique({
      where: { id },
      include: { permissions: true },
    });
    if (!source) {
      return NextResponse.json({ error: 'الدور غير موجود' }, { status: 404 });
    }
    // Company roles may only be duplicated within the same company.
    if (source.companyId !== null && source.companyId !== admin.companyId) {
      return NextResponse.json({ error: 'الدور غير موجود' }, { status: 404 });
    }

    // Conferral policy: visibility is NOT authorization. The actor may only
    // duplicate a role whose full canonical matrix they could grant themselves
    // (granter-must-hold) — no permission laundering through copying a rich
    // system/other role. Rejected wholesale, before any write.
    const conferral = await canConferRole(admin, { id: source.id, name: source.name });
    if (!conferral.ok) {
      return NextResponse.json({ error: conferral.error }, { status: conferral.status });
    }

    // The copy carries the source's rows, minus any key the catalog has stopped offering (none yet). Judged against
    // the source: a template's own old orphan is copied as it is, but stripping a key must never leave a NEW one.
    const rows = withoutRetired(source.permissions);
    const orphan = newOrphanRefusal(rows.map((p) => p.permission), source.permissions.map((p) => p.permission));
    if (orphan) return orphanResponse(orphan);

    const targetCompanyId = admin.companyId ?? source.companyId;
    let newName = `${source.name} (نسخة)`;
    // Ensure name uniqueness within the tenant.
    let suffix = 2;
    while (await db.role.findFirst({ where: { companyId: targetCompanyId, name: newName }, select: { id: true } })) {
      newName = `${source.name} (نسخة ${suffix++})`;
    }

    const copy = await db.$transaction(async (tx) => {
      return tx.role.create({
        data: {
          companyId: targetCompanyId,
          name: newName,
          isSystem: false,
          permissions: {
            create: rows.map((p) => ({
              permission: p.permission,
              scope: p.scope,
              scopeIds: p.scopeIds ?? undefined,
            })),
          },
          // The copy was issued with what it was copied from — that is its
          // baseline, not whatever the source role drifts to afterwards.
          defaults: {
            create: rows.map((p) => ({
              permission: p.permission,
              scope: p.scope,
              scopeIds: p.scopeIds ?? undefined,
            })),
          },
        },
        include: { permissions: true },
      });
    });

    await logAudit({
      companyId: targetCompanyId ?? 'platform',
      userId: admin.id,
      action: 'ROLE_DUPLICATED',
      entity: 'Role',
      entityId: copy.id,
      previousData: { sourceRoleId: source.id, sourceName: source.name },
      newData: { name: copy.name, permissionsCount: copy.permissions.length },
    });

    return NextResponse.json({ success: true, role: copy }, { status: 201 });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
