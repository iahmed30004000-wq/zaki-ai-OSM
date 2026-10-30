import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { dispatchBatch } from '@/lib/couriers/dispatch';

/**
 * POST /api/ops/shipments/[id]/dispatch
 *
 * Hand this batch's orders to the shipping company and record the barcode
 * each one comes back with. That barcode is the reference from then on: it
 * is what the waybill carries, what the status sync asks about, and what
 * their statement line is matched against.
 *
 * Deliberately a separate call from creating the batch. Creating the batch
 * is our own bookkeeping and must always succeed; sending to a courier is a
 * network call to somebody else's server, and the two failing together
 * would mean a warehouse that cannot group a shipment because an API is
 * down.
 */

interface Ctx {
  params: Promise<{ id: string }>;
}

const schema = z.object({
  /** Narrow to a retry of specific orders; omitted, the whole batch. */
  orderIds: z.array(z.string().min(10).max(64)).max(500).optional(),
});

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.ship');
    const { id } = await ctx.params;

    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    }

    const summary = await dispatchBatch({
      batchId: id,
      companyId,
      storeId,
      userId: user.id,
      orderIds: parsed.data.orderIds,
    });

    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof Error && error.message === 'BATCH_NOT_FOUND') {
      return NextResponse.json({ error: 'الدفعة غير موجودة' }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'BATCH_NOT_READY') {
      return NextResponse.json(
        {
          error: 'الدفعة ما عادت قيد التجميع (سُلّمت أو انغلقت) — ما بيصير ترحيلها للشركة من جديد',
          errorAr: 'الدفعة ما عادت قيد التجميع (سُلّمت أو انغلقت) — ما بيصير ترحيلها للشركة من جديد',
          code: 'BATCH_NOT_READY',
        },
        { status: 409 }
      );
    }
    return apiErrorResponse(error);
  }
}
