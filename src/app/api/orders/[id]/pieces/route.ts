import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { authorize } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { orderSeal } from '@/lib/order-seal';
import { logAudit } from '@/lib/audit';
import {
  activeVariants,
  checkUnits,
  freeOfVariants,
  parseVariantOptions,
  readVariantsView,
  unitsOfGroups,
  variantSummary,
  writeLineVariants,
} from '@/lib/product-variants';

/**
 * /api/orders/[id]/pieces — THE SIZE AND COLOUR OF EVERY PIECE, set by the team (product variants, the owner 2026-11-18).
 *
 *   GET → { lines: [{ id, productName, quantity, freeQuantity, units, variants }] } — the lines of products with variants.
 *   PUT { itemId, units: [variantId…] } → records one combination per piece of that line (paid pieces first, then gifts).
 *
 * The door for an order that came without a choice per piece (an older page, an abandoned cart, a lines edit that
 * changed the units), and for a customer who changes a size on the call. It writes the pieces only: THE MONEY IS NOT
 * TOUCHED. If the new pieces carry a different price difference, the screen says so and the price is changed where a
 * price is always changed — the lines edit. A sealed parcel (printed, handed over, shipped) is not changed here.
 *
 * Stock: a combination must still have the pieces free (what other orders hold excluded); this order's own hold is
 * left out of the count, so changing «L» for «L» never refuses itself.
 */
const body = z.object({
  itemId: z.string().trim().min(1).max(64),
  units: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    // The order window's own read rule — open to the order she holds (order-work-door.ts), as the timeline is.
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) return NextResponse.json({ error: 'الطلب غير موجود أو ليس بين يديك' }, { status: ORDER_ACCESS_STATUS[access.reason] });

    const items = await db.orderItem.findMany({
      where: { orderId: id, companyId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        productName: true,
        quantity: true,
        freeQuantity: true,
        variantSummary: true,
        product: { select: { id: true, storeId: true, variantOptions: true } },
        variants: { orderBy: { createdAt: 'asc' }, select: { variantId: true, label: true, quantity: true, freeQuantity: true } },
      },
    });
    const lines = [];
    for (const i of items) {
      if (parseVariantOptions(i.product.variantOptions).length === 0) continue;
      lines.push({
        id: i.id,
        productName: i.productName,
        quantity: i.quantity,
        freeQuantity: i.freeQuantity,
        variantSummary: i.variantSummary,
        units: unitsOfGroups(i.variants),
        variants: await readVariantsView(db, companyId, i.product, false),
      });
    }
    return NextResponse.json({ lines });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const access = await assertOrderAccess(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) return NextResponse.json({ error: 'الطلب غير موجود أو ليس بين يديك' }, { status: ORDER_ACCESS_STATUS[access.reason] });
    if (!authorize(user, 'orders.edit', access.order).allowed) {
      return NextResponse.json({ error: 'تعديل الطلب ليس من صلاحيّاتك.', code: 'EDIT_FORBIDDEN' }, { status: 403 });
    }

    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    const { itemId, units } = parsed.data;

    const order = await db.order.findFirst({
      where: { id, companyId },
      select: {
        id: true, storeId: true, confirmationStatus: true, shippingStatus: true, shippedAt: true, labelPrintedAt: true,
        shippingBatch: { select: { status: true, batchNumber: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });
    if (order.confirmationStatus === 'CANCELLED' || order.confirmationStatus === 'REJECTED') {
      return NextResponse.json({ error: 'الطلب ملغى أو مرفوض.', code: 'ORDER_ENDED' }, { status: 409 });
    }
    const seal = orderSeal({ shippingBatch: order.shippingBatch, shippingStatus: order.shippingStatus, shippedAt: order.shippedAt, labelPrintedAt: order.labelPrintedAt });
    if (seal.sealed) return NextResponse.json({ error: 'الطرد طُبع أو خرج — القطع ما بتتغيّر من هون.', code: 'ORDER_SEALED' }, { status: 409 });

    const item = await db.orderItem.findFirst({
      where: { id: itemId, orderId: id, companyId },
      select: { id: true, productId: true, quantity: true, freeQuantity: true, variantSummary: true, product: { select: { id: true, variantOptions: true } } },
    });
    if (!item) return NextResponse.json({ error: 'السطر غير موجود' }, { status: 404 });
    const options = parseVariantOptions(item.product.variantOptions);
    if (options.length === 0) return NextResponse.json({ error: 'هذا المنتج بلا مقاسات أو ألوان.', code: 'NO_VARIANTS' }, { status: 400 });

    const rows = await activeVariants(db, companyId, item.productId);
    const free = await freeOfVariants(db, { companyId, productId: item.productId, rows, exceptOrderId: id, storeId: order.storeId });
    const checked = checkUnits({ options, rows, free, units, paid: item.quantity, gift: item.freeQuantity });
    if (!checked.ok) return NextResponse.json({ error: Object.values(checked.fieldErrors)[0], fieldErrors: checked.fieldErrors }, { status: 400 });

    const before = item.variantSummary;
    await db.$transaction(async (tx) => {
      await writeLineVariants(tx, { companyId, orderId: id, orderItemId: item.id, productId: item.productId, groups: checked.groups });
      await tx.orderActivity.create({
        data: {
          companyId, orderId: id, userId: user.id, action: 'ORDER_PIECES_SET',
          metadata: JSON.stringify({ from: before, to: variantSummary(checked.groups), variantDelta: checked.delta }),
        },
      });
    });
    await logAudit({
      companyId, userId: user.id, action: 'ORDER_PIECES_SET', entity: 'Order', entityId: id,
      previousData: { pieces: before }, newData: { pieces: variantSummary(checked.groups) },
    });
    return NextResponse.json({ ok: true, variantSummary: variantSummary(checked.groups), variantDelta: checked.delta });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
