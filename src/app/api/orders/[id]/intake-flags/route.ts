import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { apiErrorResponse } from '@/lib/api-error';
import { INTAKE_DUPLICATE_ACTION, INTAKE_SUSPECT_ACTION, INTAKE_WINDOW_MS } from '@/lib/intake-flags';

/**
 * GET /api/orders/:id/intake-flags — what the intake filter wrote on this order (`intake-filter.ts`, step C1).
 *
 * The flags were written once, after the order arrived. This only reads them back for the order window, through the same envelope the window itself opens the
 * order with — so a reader sees the notice on exactly the orders she may open. It answers with the OTHER order's number and a yes/no and nothing else: no ids, no
 * names, no phone. Silent (both empty) when the switch was never on for this company: nothing was written.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    const rows = await db.orderActivity.findMany({
      where: { orderId: id, companyId, action: { in: [INTAKE_DUPLICATE_ACTION, INTAKE_SUSPECT_ACTION] } },
      orderBy: { createdAt: 'desc' },
      select: { action: true, metadata: true },
    });

    let duplicateOf: string | null = null;
    const dup = rows.find((r) => r.action === INTAKE_DUPLICATE_ACTION);
    if (dup?.metadata) {
      try {
        const n = (JSON.parse(dup.metadata) as { firstOrderNumber?: unknown }).firstOrderNumber;
        if (typeof n === 'string' && n) duplicateOf = n;
      } catch {
        duplicateOf = null;
      }
    }

    return NextResponse.json({
      duplicateOf,
      suspectNumber: rows.some((r) => r.action === INTAKE_SUSPECT_ACTION),
      windowHours: INTAKE_WINDOW_MS / 3_600_000,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
