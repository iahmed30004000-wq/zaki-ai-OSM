import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { LIST_DAYS, listRowsWhere } from '@/lib/winback-private-list';
import { readWinbackPrices, priceOf } from '@/lib/winback-prices';

/**
 * GET /api/confirmation/winback/list — «قايمة الاسترجاع تبعي»: HER private win-back list (`winback-private-list.ts`).
 *
 * The orders handed to her by «وزّع على الموظفات», still open: the order, the product, the option it stands at (1 or 3 pieces) and the
 * two prices, the cancelled order's own quantity (information only), and the day it leaves her list if nobody touches it. She works
 * each order through the doors she works any order she holds through — the order opens where it is listed. No customer field: the
 * order opens under the usual access.
 *
 * Who: `confirmation.work` (her own list). A manager (`orders.assign`) may read an agent's list with `?agentId=`.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.work');
    if (!storeId) return NextResponse.json({ error: 'اختار متجر.', errorAr: 'اختار متجر.', code: 'STORE_REQUIRED' }, { status: 400 });
    const asked = new URL(req.url).searchParams.get('agentId');
    const agentId = asked && asked !== user.id ? (can(user, 'orders.assign') ? asked : null) : user.id;
    if (!agentId) return NextResponse.json({ error: 'قايمة موظفة تانية للمدير بس.', errorAr: 'قايمة موظفة تانية للمدير بس.', code: 'NOT_YOURS' }, { status: 403 });

    const [rows, prices] = await Promise.all([
      db.order.findMany({
        where: listRowsWhere({ companyId, storeId }, agentId),
        orderBy: [{ winbackListAt: 'asc' }, { id: 'asc' }],
        take: 500,
        select: {
          id: true,
          orderNumber: true,
          productId: true,
          productNameSnapshot: true,
          quantity: true,
          totalAmount: true,
          currency: true,
          confirmationStatus: true,
          winbackListAt: true,
          _count: { select: { contactAttempts: true } },
          replaces: { select: { orderNumber: true, quantity: true, freeQuantity: true, items: { select: { quantity: true, freeQuantity: true } } } },
        },
      }),
      readWinbackPrices(companyId),
    ]);
    return NextResponse.json({
      listDays: LIST_DAYS,
      rows: rows.map((o) => {
        const src = o.replaces;
        const oldPieces = src ? (src.items.length ? src.items.reduce((n, l) => n + l.quantity + (l.freeQuantity ?? 0), 0) : (src.quantity ?? 0) + (src.freeQuantity ?? 0)) : null;
        const entry = prices[o.productId];
        return {
          id: o.id,
          orderNumber: o.orderNumber,
          product: o.productNameSnapshot,
          pieces: o.quantity,
          total: o.totalAmount,
          currency: o.currency,
          status: o.confirmationStatus,
          touched: o._count.contactAttempts > 0 || o.confirmationStatus !== 'NEW',
          oldOrderNumber: src?.orderNumber ?? null,
          oldPieces,
          options: entry && entry.currency === o.currency ? { one: priceOf(entry, 1), three: priceOf(entry, 3) } : null,
          leavesAt: o.winbackListAt ? new Date(o.winbackListAt.getTime() + LIST_DAYS * 86_400_000).toISOString() : null,
        };
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
