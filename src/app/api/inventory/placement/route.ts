import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { storeIsPlaced, warehousesOfStore, warehousesReachedBy } from '@/lib/warehouses';
import {
  PlacementRefused,
  VARIANTS_STAY_STORE_LEVEL_AR,
  countsSchema,
  placeStore,
  previewPlacement,
  refusalStatus,
} from '@/lib/warehouse-placement';
import { refuse, refuseUnreached } from '@/lib/placement-door';

/**
 * GET  /api/inventory/placement (inventory.view)   — is this store placed; if not, its warehouses and the table to count against
 * POST /api/inventory/placement (inventory.adjust) — place it, once
 *
 * The opening placement of the warehouse plan: the store's book stock is divided between the warehouses its keepers
 * counted. Every rule lives in `src/lib/warehouse-placement.ts` (the plan, the exactness, the batch steps) — this door
 * adds the session: the store is the caller's, and every warehouse named must be one the caller reaches. The key is
 * `inventory.adjust`, the one that already governs putting stock in and the opening count; a new key would be one more
 * grant to remember before a store can be placed at all.
 */

const bodySchema = z.object({
  countedByName: z.string().trim().min(3, 'اكتب اسم اللي عدّ').max(120),
  countedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  note: z.string().trim().max(500).optional().nullable(),
  counts: countsSchema,
});

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');

    if (await storeIsPlaced(storeId)) {
      const placement = await db.warehousePlacement.findUnique({
        where: { storeId },
        select: { countedByName: true, countedAt: true, createdAt: true },
      });
      return NextResponse.json({ placed: true, placement });
    }

    const own = await warehousesOfStore(companyId, storeId);
    const warehouses = await warehousesReachedBy(user, companyId, own.map((w) => ({ ...w, companyId })));
    const plan = await previewPlacement(db, { companyId, storeId, counts: [] });
    return NextResponse.json({
      placed: false,
      warehouses: warehouses.map((w) => ({ id: w.id, name: w.name })),
      rows: plan.rows,
      variantsNote: VARIANTS_STAY_STORE_LEVEL_AR,
    });
  } catch (error) {
    if (error instanceof PlacementRefused) return refuse(refusalStatus(error.code), error.code, error.errorAr);
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.adjust');

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', parsed.error.issues[0]?.message ?? 'البيانات ناقصة');
    const input = parsed.data;

    const unreached = await refuseUnreached(user, companyId, input.counts);
    if (unreached) return unreached;

    try {
      const result = await db.$transaction(
        (tx) =>
          placeStore(tx, {
            companyId,
            storeId,
            countedByName: input.countedByName,
            countedAt: new Date(input.countedAt),
            note: input.note,
            recordedById: user.id,
            counts: input.counts,
          }),
        // A store of a few hundred products is a few hundred lock statements and row writes: the default five seconds is
        // a timeout waiting to happen on the busiest day, and a timeout here rolls everything back (nothing half placed).
        { timeout: 60_000, maxWait: 10_000 }
      );

      await logAudit({
        companyId,
        userId: user.id,
        action: 'STOCK_PLACED_IN_WAREHOUSES',
        entity: 'Store',
        entityId: storeId,
        newData: {
          countedByName: result.placement.countedByName,
          countedAt: result.placement.countedAt.toISOString(),
          perWarehouse: result.plan.totals,
          products: result.plan.rows.length,
          withCourier: result.plan.rows.reduce((s, r) => s + r.withCourier, 0),
          batchesTouched: result.plan.steps.length,
          twins: result.plan.steps.reduce((s, st) => s + st.twins.length, 0),
          recordedBy: user.name,
        },
      });

      return NextResponse.json({ placement: result.placement, rows: result.plan.rows, totals: result.plan.totals }, { status: 201 });
    } catch (e: unknown) {
      if (e instanceof PlacementRefused) {
        const ar = e.errorAr;
        return NextResponse.json(
          { error: ar, errorAr: ar, code: e.code, ...(e.differing ? { differing: e.differing } : {}) },
          { status: refusalStatus(e.code) }
        );
      }
      // Two presses at once: the one-row-per-store rule of the database answers the second.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return refuse(409, 'ALREADY_PLACED', 'هالمتجر انوزّع على المخازن هلّق. حدّث الصفحة.');
      }
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
