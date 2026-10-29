import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { catalogItem, dependentsOf, isRetiredKey } from '@/lib/permission-catalog';
import { canActOnUser, denyRemovalRefusal, loadPermissionTarget, orphanResponse, overrideOrphanRefusal, superAdminOverrideGuard } from '@/lib/user-permissions';

/**
 * DELETE /api/users/:id/permissions/:permission — remove a single override row
 * (users.edit). 404 when no override exists for that permission key.
 * Same tenant boundary + SUPER_ADMIN guards as the collection route.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; permission: string }> }
) {
  try {
    const { id, permission } = await params;
    const admin = await requirePermission('users.edit');

    const loaded = await loadPermissionTarget(id, admin);
    if (!loaded.ok) return loaded.response;
    const target = loaded.user;

    if (target.id === admin.id) {
      return NextResponse.json({ error: 'لا يمكنك تعديل صلاحيات حسابك الشخصي' }, { status: 400 });
    }

    // SUPER_ADMIN is full-access by engine precedence — no overrides, ever.
    const superBlock = superAdminOverrideGuard(target);
    if (superBlock) return superBlock;

    // Not on an account whose role carries powers this admin lacks.
    const acting = await canActOnUser(admin, target);
    if (!acting.ok) return NextResponse.json({ error: acting.error }, { status: acting.status });

    const existing = await db.userPermission.findUnique({
      where: { userId_permission: { userId: id, permission } },
    });
    if (!existing) {
      return NextResponse.json({ error: 'لا يوجد استثناء لهذه الصلاحية' }, { status: 404 });
    }
    // Deleting a DENY hands the key back: it asked nothing before.
    // (A retired key is nothing to lift: nothing asks it, so there is no door to hand back.)
    if (existing.effect === 'DENY' && !isRetiredKey(existing.permission)) {
      const refusal = denyRemovalRefusal(admin, [existing.permission]);
      if (refusal) return NextResponse.json({ error: refusal }, { status: 403 });
    }

    /*
     * AND THE ONE DOOR THE LIST-REPLACING PUT DOES NOT GUARD.
     *
     * Removing a row can leave an action without its screen key, just as
     * writing one can: lifting an ALLOW on a view the role does not give, or a
     * «منع» on an action whose view is still denied. The same rule as the PUT —
     * only what this removal ADDS is refused. It reads the rows only when this
     * row could matter (an ALLOW somebody else needs, or a «منع» on an action).
     */
    const couldMatter =
      existing.effect === 'ALLOW' ? dependentsOf(existing.permission).length > 0 : !!catalogItem(existing.permission)?.requires;
    if (couldMatter) {
      const rows = await db.userPermission.findMany({ where: { userId: id } });
      const orphan = await overrideOrphanRefusal(target, rows, rows.filter((r) => r.permission !== existing.permission));
      if (orphan) return orphanResponse(orphan);
    }

    await db.$transaction([
      db.userPermission.delete({
        where: { userId_permission: { userId: id, permission } },
      }),
      // Invalidate cached grants — the target recomputes on their next request.
      db.user.update({ where: { id }, data: { permissionsVersion: { increment: 1 } } }),
    ]);

    await logAudit({
      companyId: target.companyId || admin.companyId || 'platform',
      userId: admin.id,
      action: 'USER_PERMISSION_OVERRIDE_REMOVED',
      entity: 'User',
      entityId: target.id,
      previousData: {
        targetUserId: target.id,
        permission: existing.permission,
        effect: existing.effect,
        scope: existing.scope,
        scopeIds: existing.scopeIds,
      },
      newData: { removedBy: admin.name },
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
