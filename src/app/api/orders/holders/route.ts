import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { getPermissionScope } from '@/lib/authorization';
import { apiError } from '@/lib/api-error';

/**
 * GET /api/orders/holders — the names behind the «ماسكه» filter on «الطلبات».
 *
 * Whoever holds at least one order of this store right now (`claimedById`),
 * with how many. Read from the orders, the way `/api/orders/sources` reads the
 * channels: the list is whoever is holding something today, not a roster.
 *
 * Only for whoever sees every order («عرض الطلبات» at «كل الشركة»). The filter
 * itself never widens a list — it is ANDed under the person's own envelope —
 * but a list of colleagues and their loads is the supervisor's picture, and an
 * agent whose list is her own work has no use for it. The screen draws the
 * filter only when this door answers.
 */
export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    if (getPermissionScope(user, 'orders.view')?.scope !== 'ALL_COMPANY') {
      return NextResponse.json(
        { error: 'Forbidden: needs company-wide orders.view', errorAr: 'فلتر «ماسكه» لمن يرى كل الطلبات.' },
        { status: 403 }
      );
    }

    const rows = await db.order.groupBy({
      by: ['claimedById'],
      where: { companyId, storeId, claimedById: { not: null } },
      _count: { _all: true },
    });
    const ids = rows.map((r) => r.claimedById).filter((id): id is string => !!id);
    const people = ids.length
      ? await db.user.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));

    const holders = rows
      // A holder outside this company (a platform account) is not named here.
      .filter((r) => r.claimedById && nameOf.has(r.claimedById))
      .map((r) => ({ id: r.claimedById as string, name: nameOf.get(r.claimedById as string) as string, count: r._count._all }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ holders });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
