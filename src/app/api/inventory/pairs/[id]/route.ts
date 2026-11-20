import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { TX_OPTIONS } from '@/lib/stock-transfer-door';
import { ProductPairRefused, pairRefusalBody, removePair, storesReachedBy } from '@/lib/product-pairs';

/**
 * DELETE /api/inventory/pairs/:id (inventory.transfer) — remove a pair of the store the caller stands in, whose other
 * store she reaches. The warehouse plan, request W7a; the rule is `product-pairs.removePair`. Nothing reads the pairs
 * yet, so removing one changes nothing else; the audit line keeps who removed which.
 */

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.transfer');

    const reachedIds = new Set((await storesReachedBy(db, user, companyId)).map((s) => s.id));
    const removed = await db.$transaction(
      (tx) => removePair(tx, { companyId, storeId, pairId: id, reaches: async (s) => reachedIds.has(s) }),
      TX_OPTIONS
    );
    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_PAIR_REMOVED',
      entity: 'ProductPair',
      entityId: removed.id,
      previousData: { productId: removed.productId, otherProductId: removed.otherProductId, otherStoreId: removed.otherStoreId, hint: removed.hint },
      newData: { by: user.name },
    });
    return NextResponse.json({ removed: { id: removed.id } });
  } catch (error) {
    if (error instanceof ProductPairRefused) return NextResponse.json(pairRefusalBody(error), { status: error.status });
    return apiErrorResponse(error);
  }
}
