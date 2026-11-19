import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { firstIssue, warehouseUpdateSchema } from '@/lib/geo-schemas';
import { WAREHOUSE_NAME_TAKEN_AR, WAREHOUSE_NOT_FOUND_AR, stopRefusalAr, warehouseStopBlockers } from '@/lib/warehouses';
import { lockWarehouseForStop } from '@/lib/warehouse-intake';

/**
 *   PATCH /api/geo/warehouses/:id  (geo.manage) — { name?, isActive? }
 *
 * Rename, stop, start. There is no DELETE: a stopped warehouse stays in the
 * history of every batch, movement and shipment that names it. Stopping is
 * refused (409) while the warehouse still holds units — the one list of
 * reasons is `warehouseStopBlockers`, read inside the same transaction as
 * the write. The receiving and production doors (W2a) refuse a stopped
 * warehouse inside their own transaction, reading its row FOR SHARE; the stop
 * locks the row FOR UPDATE before it counts, so the two cannot cross.
 */

const refuse = (status: number, code: string, ar: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: ar, errorAr: ar, code, ...extra }, { status });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');

    const parsed = warehouseUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', firstIssue(parsed.error));

    const before = await db.warehouse.findFirst({ where: { id, companyId } });
    if (!before) return refuse(404, 'NOT_FOUND', WAREHOUSE_NOT_FOUND_AR);

    const name = parsed.data.name;
    if (name !== undefined && name !== before.name) {
      const clash = await db.warehouse.findFirst({
        where: { companyId, countryId: before.countryId, name, id: { not: id } },
        select: { id: true },
      });
      if (clash) return refuse(409, 'NAME_TAKEN', WAREHOUSE_NAME_TAKEN_AR);
    }

    const stopping = parsed.data.isActive === false && before.isActive;
    let outcome: { refused: Awaited<ReturnType<typeof warehouseStopBlockers>> } | { warehouse: typeof before };
    try {
      outcome = await db.$transaction(async (tx) => {
        if (stopping) {
          // 19/11 (W2a): the row FOR UPDATE first, so a receipt into it (which reads it FOR SHARE) and this stop cannot
          // cross — whichever comes second sees what the first wrote (`warehouse-intake.ts`, race 2).
          await lockWarehouseForStop(tx, id);
          const blockers = await warehouseStopBlockers(tx, companyId, id);
          if (blockers.length > 0) return { refused: blockers };
        }
        const warehouse = await tx.warehouse.update({ where: { id }, data: parsed.data });
        return { warehouse };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return refuse(409, 'NAME_TAKEN', WAREHOUSE_NAME_TAKEN_AR);
      }
      throw e;
    }
    if ('refused' in outcome) {
      return refuse(409, 'WAREHOUSE_NOT_EMPTY', stopRefusalAr(outcome.refused), { blockers: outcome.refused });
    }

    const action = parsed.data.isActive === undefined || parsed.data.isActive === before.isActive
      ? 'WAREHOUSE_RENAMED'
      : parsed.data.isActive
        ? 'WAREHOUSE_STARTED'
        : 'WAREHOUSE_STOPPED';
    await logAudit({
      companyId,
      userId: user.id,
      action,
      entity: 'Warehouse',
      entityId: id,
      previousData: before,
      newData: outcome.warehouse,
    });
    return NextResponse.json({ warehouse: outcome.warehouse });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
