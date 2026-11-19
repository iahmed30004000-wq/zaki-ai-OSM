import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { PlacementRefused, countsSchema, notExactAr, previewPlacement, refusalStatus } from '@/lib/warehouse-placement';
import { refuse, refuseUnreached } from '@/lib/placement-door';

/**
 * POST /api/inventory/placement/preview (inventory.view) — the placement's table for these counts, WRITING NOTHING.
 *
 * The same checks and the same plan as the press (`warehouse-placement.previewPlacement` ≡ what `placeStore` then does),
 * so the sheet shows per product what the book says there is to place, what was counted, and the difference — and only
 * an all-zero difference lets the press through. POST and not GET because the counts are the question.
 */

const bodySchema = z.object({ counts: countsSchema });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', parsed.error.issues[0]?.message ?? 'البيانات ناقصة');

    const unreached = await refuseUnreached(user, companyId, parsed.data.counts);
    if (unreached) return unreached;

    const plan = await previewPlacement(db, { companyId, storeId, counts: parsed.data.counts });
    return NextResponse.json({
      exact: plan.exact,
      rows: plan.rows,
      differing: plan.differing,
      totals: plan.totals,
      // The sentence the press would answer with, said before the press.
      ...(plan.exact ? {} : { messageAr: notExactAr(plan.differing) }),
    });
  } catch (error) {
    if (error instanceof PlacementRefused) return refuse(refusalStatus(error.code), error.code, error.errorAr);
    return apiErrorResponse(error);
  }
}
