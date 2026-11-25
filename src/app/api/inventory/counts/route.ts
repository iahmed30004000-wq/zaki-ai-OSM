import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { warehousesOfStore } from '@/lib/warehouses';
import { COUNT_STATUS_AR, openCount, openSchema, type CountStatus } from '@/lib/stock-counts';
import { countRefusalOf, shownFor } from '@/lib/stock-count-door';
import { arabicIssue, reachFor, refuse, TX_OPTIONS } from '@/lib/stock-transfer-door';

/**
 * GET  /api/inventory/counts (inventory.view) — the store's count sheets, newest first, with its warehouses
 * POST /api/inventory/counts (inventory.count) — open a sheet for ONE warehouse: all the store's products, or a list
 *
 * The warehouse plan, request W5a. Every rule is in `src/lib/stock-counts.ts`. The list carries NO line and no figure —
 * only who, where, when and the status; a sheet's lines are read one sheet at a time (`/api/inventory/counts/:id`),
 * through the blind rule (`stock-count-door.shownFor`). Nothing here touches money.
 */

export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');

    const [rows, warehouses] = await Promise.all([
      // THIS store's sheets only — a warehouse may hold the goods of several stores of its country.
      db.stockCount.findMany({
        where: { companyId, storeId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          warehouseId: true,
          status: true,
          scope: true,
          note: true,
          openedById: true,
          openedAt: true,
          submittedById: true,
          submittedAt: true,
          decidedById: true,
          decidedAt: true,
          voidReason: true,
          lines: { select: { productId: true } },
        },
      }),
      warehousesOfStore(companyId, storeId),
    ]);
    const peopleIds = [...new Set(rows.flatMap((r) => [r.openedById, r.submittedById, r.decidedById]).filter((x): x is string => !!x))];
    const whIds = [...new Set(rows.map((r) => r.warehouseId))];
    const [people, places] = await Promise.all([
      peopleIds.length ? db.user.findMany({ where: { id: { in: peopleIds }, companyId }, select: { id: true, name: true } }) : [],
      whIds.length ? db.warehouse.findMany({ where: { id: { in: whIds }, companyId }, select: { id: true, name: true } }) : [],
    ]);
    const who = new Map(people.map((p) => [p.id, p.name]));
    const where = new Map(places.map((w) => [w.id, w.name]));

    return NextResponse.json({
      warehouses: warehouses.map((w) => ({ id: w.id, name: w.name })),
      counts: rows.map(({ lines, ...r }) => ({
        ...r,
        statusAr: COUNT_STATUS_AR[r.status as CountStatus] ?? r.status,
        lineCount: lines.length,
        warehouseName: where.get(r.warehouseId) ?? null,
        openedByName: who.get(r.openedById) ?? null,
        submittedByName: r.submittedById ? who.get(r.submittedById) ?? null : null,
        decidedByName: r.decidedById ? who.get(r.decidedById) ?? null : null,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.count');

    const parsed = openSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', arabicIssue(parsed.error));

    try {
      const count = await db.$transaction(
        (tx) => openCount(tx, { companyId, storeId, openedById: user.id, body: parsed.data, mayUse: reachFor(user, companyId) }),
        TX_OPTIONS
      );
      await logAudit({
        companyId,
        userId: user.id,
        action: 'STOCK_COUNT_OPENED',
        entity: 'StockCount',
        entityId: count.id,
        newData: { warehouseId: count.warehouseId, scope: count.scope, lines: count.lines.length, by: user.name },
      });
      return NextResponse.json({ count: shownFor(user, count) }, { status: 201 });
    } catch (e) {
      const refused = countRefusalOf(e);
      if (refused) return refused;
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
