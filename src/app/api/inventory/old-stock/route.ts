import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { warehousesReachedBy } from '@/lib/warehouses';
import { refuse } from '@/lib/placement-door';
import { OldStockRefused, moveOldStockHome, planOldStock, readOldStockFacts } from '@/lib/old-stock-home';
import type { SessionUser } from '@/types/auth';

/**
 * GET  /api/inventory/old-stock?warehouse=<id> (inventory.adjust) — what would move into that warehouse, nothing written
 * POST /api/inventory/old-stock                (inventory.adjust) — move it, once per store
 *
 * Every rule lives in `src/lib/old-stock-home.ts` (the owner, 27/11: «كل إشي قديم من قدسيا»). This door adds the session:
 * the store is the caller's, and every warehouse named must be one the caller reaches. The key is the placement's.
 */

const bodySchema = z.object({
  warehouseId: z.string().min(1).max(64),
  restores: z
    .array(
      z.object({
        productId: z.string().min(1).max(64),
        warehouseId: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(10_000_000),
      })
    )
    .max(2000),
});

const NOT_REACHED_AR = 'ما إلك وصول على كل المخازن المذكورة.';

async function unreached(user: SessionUser, companyId: string, ids: readonly string[]) {
  const named = await db.warehouse.findMany({
    where: { companyId, id: { in: [...new Set(ids)] } },
    select: { id: true, companyId: true, countryId: true },
  });
  const reached = await warehousesReachedBy(user, companyId, named);
  return reached.length < named.length ? refuse(403, 'WAREHOUSE_NOT_REACHED', NOT_REACHED_AR) : null;
}

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.adjust');

    const placement = await db.warehousePlacement.findUnique({ where: { storeId }, select: { oldStockWarehouseId: true, createdAt: true } });
    if (!placement) throw new OldStockRefused('NOT_PLACED');
    if (placement.oldStockWarehouseId) throw new OldStockRefused('ALREADY_DONE');

    const facts = await readOldStockFacts(db, companyId, storeId, placement.createdAt);
    const asked = new URL(req.url).searchParams.get('warehouse')?.trim() || null;
    if (asked && !facts.warehouses.some((w) => w.id === asked)) throw new OldStockRefused('WAREHOUSE_NOT_FOUND');
    if (asked) {
      const stop = await unreached(user, companyId, [asked]);
      if (stop) return stop;
    }
    // What the person typed, when they typed: `edited=1` and one `r=product:warehouse:units` per figure above zero.
    const query = new URL(req.url).searchParams;
    const typed = query.get('edited') === '1'
      ? query.getAll('r').flatMap((s) => {
          const [productId, warehouseId, units] = s.split(':');
          const quantity = Number(units);
          return productId && warehouseId && Number.isInteger(quantity) && quantity > 0 ? [{ productId, warehouseId, quantity }] : [];
        })
      : undefined;
    return NextResponse.json({
      warehouses: facts.warehouses,
      orders: facts.orders,
      // The table only once a home is chosen: without one there is no «after» to say.
      rows: asked ? planOldStock(facts, asked, typed) : [],
    });
  } catch (error) {
    if (error instanceof OldStockRefused) return refuse(error.status, error.code, error.errorAr);
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.adjust');

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', 'البيانات ناقصة: المخزن، وشو بيرجع لكل مخزن.');
    const input = parsed.data;

    const stop = await unreached(user, companyId, [input.warehouseId, ...input.restores.map((r) => r.warehouseId)]);
    if (stop) return stop;

    const result = await db.$transaction(
      (tx) =>
        moveOldStockHome(tx, {
          companyId,
          storeId,
          homeWarehouseId: input.warehouseId,
          restores: input.restores,
          userId: user.id,
        }),
      // A shop's whole shelf and a few thousand order rows: the default five seconds would roll it all back on a busy day.
      { timeout: 60_000, maxWait: 10_000 }
    );

    await logAudit({
      companyId,
      userId: user.id,
      action: 'OLD_STOCK_GIVEN_A_WAREHOUSE',
      entity: 'Store',
      entityId: storeId,
      newData: {
        warehouseId: input.warehouseId,
        orders: result.orders,
        batchRows: result.batchRows,
        restores: input.restores,
        products: result.rows.map((r) => ({
          productId: r.productId,
          unplaced: r.unplaced,
          oldHeld: r.oldHeld,
          warehouses: r.warehouses.map((w) => ({ id: w.id, before: w.before.onHand, after: w.after.onHand, restore: w.restore })),
        })),
      },
    });

    return NextResponse.json({ orders: result.orders, rows: result.rows }, { status: 201 });
  } catch (error) {
    if (error instanceof OldStockRefused) return refuse(error.status, error.code, error.errorAr);
    return apiErrorResponse(error);
  }
}
