import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { computeCod, roundMinor } from '@/lib/money';
import { OPEN_CONFIRMATION } from '@/lib/confirmation-queue';
import { fixedCostsOf } from '@/lib/product-fixed-cost';
import { isPieces, priceOf, readWinbackPrices, winbackUnitCost } from '@/lib/winback-prices';

/**
 * PATCH /api/confirmation/winback/list/[id] { pieces: 1 | 3 } — the owner's ruling 25/11 («1 modified»): a win-back order is made at the
 * 3-piece option and the agent may switch it to 1 piece (or back). A NARROW door — and the one place an existing win-back order's
 * money is rewritten, on his word:
 *
 *   · only a win-back LIST order (`winbackListAt` set), still before confirmation (open, not shipped, in no batch);
 *   · only by its list holder, or a manager (`orders.assign` + `confirmation.winback`);
 *   · the price is the owner's setting for its product and currency — NEVER a figure from the request (the body carries `pieces` and
 *     nothing else; any other field is refused);
 *   · one line, `pieces` units, no gift, no discount, delivery included: its total IS the setting (`computeCod`, held to the minor unit);
 *     the cost is rewritten for the NEW pieces (`winbackUnitCost`: the owner's fixed figure per piece, else the cancelled order's own
 *     cost over its own pieces) — and a price below that cost is refused, as the bulk run refuses it. Nothing is reserved here.
 *
 * No other price becomes editable through it.
 */
const refuse = (errorAr: string, code: string, status: number) => NextResponse.json({ error: errorAr, errorAr, code }, { status });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'pieces') || !isPieces(body.pieces)) {
      return refuse('اختار قطعة وحدة أو 3 قطع بس.', 'INVALID_PIECES', 400);
    }
    const pieces = body.pieces;

    const order = await db.order.findFirst({
      where: { id, companyId, ...(storeId ? { storeId } : {}) },
      select: {
        id: true, version: true, orderNumber: true, productId: true, currency: true, quantity: true, totalAmount: true,
        confirmationStatus: true, shippingStatus: true, shippingBatchId: true, claimedById: true,
        winbackListAt: true, winbackListUserId: true,
        items: { select: { productId: true, productName: true } },
        replaces: { select: { estimatedCostOfGoods: true, quantity: true, freeQuantity: true, items: { select: { quantity: true, freeQuantity: true } } } },
      },
    });
    if (!order) return refuse('الطلب مش موجود.', 'NOT_FOUND', 404);
    if (!order.winbackListAt) return refuse('هاد مش طلب من قايمة الاسترجاع.', 'NOT_A_LIST_ORDER', 409);

    const holder = order.claimedById === user.id && order.winbackListUserId === user.id;
    const manager = can(user, 'orders.assign') && can(user, 'confirmation.winback');
    if (!holder && !manager) return refuse('بس صاحبة القايمة أو المدير بيغيّر عدد القطع.', 'NOT_YOURS', 403);

    if (!OPEN_CONFIRMATION.includes(order.confirmationStatus) || order.shippingStatus !== 'NOT_READY' || order.shippingBatchId) {
      return refuse('الطلب انأكّد أو دخل الشحن — ما بيتغيّر عدد قطعه من هون.', 'NOT_PENDING', 409);
    }
    const products = new Set(order.items.map((l) => l.productId));
    if (products.size > 1) return refuse('الطلب فيه أكتر من منتج.', 'MIXED_PRODUCTS', 409);
    const productId = order.items[0]?.productId ?? order.productId;

    const entry = (await readWinbackPrices(companyId))[productId];
    if (!entry || entry.currency !== order.currency) return refuse('المنتج ما إلو سعر استرجاع بعملة الطلب.', 'NO_WINBACK_PRICE', 409);
    const price = priceOf(entry, pieces);
    const money = computeCod({ lines: [{ quantity: pieces, unitPrice: price / pieces }], discount: 0, deliveryFee: 0, priceIncludesDelivery: true, minorUnit: country.minorUnit });
    if (money.cod !== roundMinor(price, country.minorUnit)) return refuse('تعذّر الوصول لسعر الاسترجاع.', 'PRICE_MISMATCH', 409);
    const src = order.replaces;
    const oldPieces = src ? (src.items.length ? src.items.reduce((n, l) => n + l.quantity + (l.freeQuantity ?? 0), 0) : (src.quantity ?? 0) + (src.freeQuantity ?? 0)) : 0;
    const per = winbackUnitCost((await fixedCostsOf(db, companyId, [productId])).get(productId), Number(src?.estimatedCostOfGoods ?? 0), oldPieces);
    const cost = roundMinor(per.unit * pieces, country.minorUnit);
    if (money.cod < cost) return refuse('سعر الاسترجاع أقل من تكلفة البضاعة.', 'PRICE_BELOW_COST', 409);
    const productName = order.items[0]?.productName ?? '';

    const done = await db.$transaction(async (tx) => {
      const won = await tx.order.updateMany({
        where: { id, companyId, version: order.version, confirmationStatus: { in: OPEN_CONFIRMATION }, shippingStatus: 'NOT_READY', shippingBatchId: null },
        data: {
          quantity: pieces,
          freeQuantity: 0,
          sellingPrice: money.subtotal,
          discountAmount: 0,
          totalAmount: money.cod,
          priceIncludesDelivery: true,
          estimatedCostOfGoods: cost,
          version: { increment: 1 },
        },
      });
      if (won.count !== 1) return false;
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await tx.orderItem.create({
        data: {
          companyId,
          orderId: id,
          productId,
          productName,
          quantity: pieces,
          freeQuantity: 0,
          unitPrice: price / pieces,
          discountShare: 0,
          lineTotal: money.lineTotals[0] ?? money.subtotal,
          addedById: user.id,
          addedStage: 'INTAKE',
        },
      });
      return true;
    });
    if (!done) return refuse('الطلب تغيّر من شي تاني — حدّث الصفحة.', 'VERSION_CONFLICT', 409);
    // The order's note said «3 قطع» when it was made: the switch writes what it is now, beside it.
    await db.orderNote.create({
      data: { companyId, orderId: id, authorId: user.id, kind: 'internal', body: `تحوّل عرض الاسترجاع لـ${pieces === 1 ? 'قطعة وحدة' : '3 قطع'} — ${money.cod}` },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'WINBACK_PIECES_SWITCHED',
      entity: 'Order',
      entityId: id,
      previousData: { pieces: order.quantity, total: order.totalAmount },
      newData: { pieces, total: money.cod, cost, costSource: per.source },
    });
    return NextResponse.json({ ok: true, pieces, total: money.cod });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
