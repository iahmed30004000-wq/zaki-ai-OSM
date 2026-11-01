import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { authorize } from '@/lib/authorization';
import { maySeeCost } from '@/lib/cost-visibility';
import { inStore } from '@/lib/store-filter';
import { money as moneyInput } from '@/lib/numeric-input';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';

/**
 * PUT /api/products/[id]/fixed-cost  { amount: number | null, reason? }
 *
 * THE ONE DOOR THAT SETS A PRODUCT'S FIXED COST (the owner, 1/11): «اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات».
 *
 *   WHO — `products.change_cost`, a key of its own beside `products.change_price`: held by the owner (full access) and ticked by
 *   him for anybody else. And the cost key (`costs.view`) too: a person who may not SEE what things cost may not set it.
 *
 *   WHAT — one row per product (`ProductFixedCost`): `amount` sets or replaces it, `null` clears it (the product then costs what
 *   its batches say again). Four decimals, never negative; zero is a real answer (an item that costs nothing). A product of another
 *   store, or of another company, is not found — the same store filter every product door uses.
 *
 *   HISTORY — an audit row with the figure before and after and the reason, since the product itself carries no timeline. Setting
 *   the same figure again writes nothing.
 *
 * It changes no order. Orders are priced from this figure in a separate step (and an order already written keeps what it was
 * written with).
 */
const body = z.object({
  amount: z.union([z.null(), moneyInput(10_000_000)]),
  reason: z.string().trim().max(200).optional(),
});

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { user, companyId, storeId } = await requireContext();

    if (!maySeeCost(user)) {
      return NextResponse.json({ error: 'التكلفة ليست من صلاحيّاتك.', errorAr: 'التكلفة ليست من صلاحيّاتك.', code: 'COST_FORBIDDEN' }, { status: 403 });
    }

    const product = await db.product.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      select: { id: true, companyId: true, storeId: true, categoryId: true, name: true, fixedCost: { select: { amount: true } } },
    });
    if (!product || product.companyId !== companyId) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });

    const allowed = authorize(user, 'products.change_cost', product);
    if (!allowed.allowed) {
      return NextResponse.json(
        { error: 'تغيير تكلفة المنتج ليس من صلاحيّاتك. اطلبها من مدير النظام.', errorAr: 'تغيير تكلفة المنتج ليس من صلاحيّاتك. اطلبها من مدير النظام.', code: 'COST_CHANGE_FORBIDDEN' },
        { status: 403 }
      );
    }

    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

    const before = product.fixedCost?.amount ?? null;
    const after = parsed.data.amount === null ? null : Number(parsed.data.amount.toFixed(4));
    if (before === after) return NextResponse.json({ fixedCost: after, unchanged: true });

    if (after === null) {
      await db.productFixedCost.deleteMany({ where: { productId: id, companyId } });
    } else {
      await db.productFixedCost.upsert({
        where: { productId: id },
        create: { companyId, productId: id, amount: after, setById: user.id },
        update: { amount: after, setById: user.id },
      });
    }

    await logAudit({
      companyId, userId: user.id, action: 'PRODUCT_FIXED_COST_SET', entity: 'Product', entityId: id,
      previousData: { fixedCost: before },
      newData: { fixedCost: after, ...(parsed.data.reason ? { reason: parsed.data.reason } : {}) },
    });

    return NextResponse.json({ fixedCost: after, previous: before });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
