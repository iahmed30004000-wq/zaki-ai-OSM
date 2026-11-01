import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { redactCustomerForWarehouse } from '@/lib/operations';
import { apiErrorResponse } from '@/lib/api-error';
import { signLabelBatch } from '@/lib/labels';
import { COURIER_KIND_SELECT, printRefusal, WAITING_FOR_BARCODE } from '@/lib/waybill';
import { zodMessage } from '@/lib/zod-message';
import { noteCustomersHandedOut } from '@/lib/pii-alert';

/**
 * Labels.
 *
 *   GET  /api/ops/labels?from&to&courier&region&printed=  candidates
 *   POST /api/ops/labels  { orderIds, width, height }     -> batch token
 *
 * The print URL carries the returned token, never a list of ids, and the
 * print route re-checks every order against the session's store.
 */

const tokenSchema = z.object({
  // Either the chosen orders, or a whole shipping batch by id.
  orderIds: z.array(z.string().uuid()).min(1).max(200).optional(),
  batchId: z.string().uuid().optional(),
  width: z.number().int().min(40).max(300).default(100),
  height: z.number().int().min(40).max(300).default(150),
  // The paper. Omitted means the page is the label — a thermal roll.
  sheetWidth: z.number().int().min(40).max(500).optional(),
  sheetHeight: z.number().int().min(40).max(500).optional(),
});

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.labels');
    // Warehouse users hold ops.labels but not customers.view: their list
    // payload must not carry phone or address.
    const maySeeContact = can(user, 'customers.view');

    const q = new URL(req.url).searchParams;
    const from = q.get('from') ? new Date(q.get('from')!) : null;
    const to = q.get('to') ? new Date(q.get('to')!) : null;
    const courier = q.get('courier');
    const regionId = q.get('region');
    const printed = q.get('printed'); // 'yes' | 'no' | null

    const orders = await db.order.findMany({
      where: {
        companyId,
        storeId,
        shippingStatus: { in: ['READY_FOR_PICKUP', 'READY_FOR_SHIPPING', 'SHIPPED', 'OUT_FOR_DELIVERY'] },
        ...(courier ? { deliveryProviderId: courier } : {}),
        ...(regionId ? { regionId } : {}),
        ...(printed === 'yes' ? { labelPrintedAt: { not: null } } : {}),
        ...(printed === 'no' ? { labelPrintedAt: null } : {}),
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: {
        id: true, orderNumber: true, merchantRef: true, trackingNumber: true, totalAmount: true,
        currency: true, labelPrintedAt: true, shippingStatus: true,
        customer: { select: { fullName: true, phone: true, city: true, address: true } },
        region: { select: { name: true } },
        deliveryProvider: { select: { name: true, code: true } },
      },
    });

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'قائمة البوالص', rows: orders });

    return NextResponse.json({
      count: orders.length,
      orders: orders.map((o) => ({ ...o, customer: redactCustomerForWarehouse(o.customer, maySeeContact) })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.labels');
    // The owner's key: a waybill for any order in any state (waybill.ts `printRefusal`). Nothing else turns it on.
    const anyOrder = can(user, 'ops.labels_any');

    const parsed = tokenSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { orderIds, batchId } = parsed.data;
    if (!orderIds?.length && !batchId) {
      return NextResponse.json({ error: 'اختر طلبات أو دفعة شحن' }, { status: 400 });
    }
    if (!storeId) return NextResponse.json({ error: 'اختر متجراً أولاً' }, { status: 400 });

    // Only orders that really belong to this store — and that may be
    // printed — enter the token. The ones that may not are named back, so
    // the screen can say which and why instead of printing fewer labels
    // than were ticked without a word.
    const rows = await db.order.findMany({
      where: batchId ? { shippingBatchId: batchId, companyId, storeId } : { id: { in: orderIds }, companyId, storeId },
      select: {
        id: true, orderNumber: true, confirmationStatus: true, shippingStatus: true, deliveryProviderId: true,
        trackingNumber: true, deliveryProvider: { select: COURIER_KIND_SELECT },
      },
    });
    if (rows.length === 0) return NextResponse.json({ error: 'لا توجد طلبات صالحة' }, { status: 404 });

    const refused: { orderNumber: string; reason: string }[] = [];
    // What the owner's key printed that the rule would have refused — said back, so the screen and the sheet can tell her.
    const outsideTheRule: { orderNumber: string; reason: string }[] = [];
    const printable = rows.filter((o) => {
      const reason = printRefusal(o, { anyOrder });
      if (reason) refused.push({ orderNumber: o.orderNumber, reason });
      else if (anyOrder) {
        const rule = printRefusal(o);
        if (rule) outsideTheRule.push({ orderNumber: o.orderNumber, reason: rule });
      }
      return !reason;
    });
    if (printable.length === 0) {
      return NextResponse.json(
        {
          // All of them waiting for the courier's barcode is a different news from the rest. The reasons are in `refused`, one
          // per order, so this sentence states no rule of its own: a rule stated over an order that kept it was the bug.
          error: refused.every((r) => r.reason === WAITING_FOR_BARCODE) ? WAITING_FOR_BARCODE : 'ما انطبع ولا طلب',
          code: 'NOTHING_PRINTABLE',
          refused,
        },
        { status: 409 }
      );
    }

    const allowed = new Set(printable.map((o) => o.id));
    const token = await signLabelBatch({
      storeId,
      // A batch token names the batch; a selection keeps the order it was
      // chosen in, which is the order it prints in.
      orderIds: batchId ? [] : (orderIds ?? []).filter((id) => allowed.has(id)),
      batchId,
      width: parsed.data.width,
      height: parsed.data.height,
      sheetWidth: parsed.data.sheetWidth,
      sheetHeight: parsed.data.sheetHeight,
    });

    const printPath = `/api/ops/labels/print?t=${token}`;
    return NextResponse.json({
      token,
      count: printable.length,
      printPath,
      pdfPath: `${printPath}&mode=pdf`,
      refused,
      outsideTheRule,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
