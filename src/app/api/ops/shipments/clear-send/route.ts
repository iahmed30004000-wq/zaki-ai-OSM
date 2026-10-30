import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { clearStuckSend } from '@/lib/couriers/send-reset';

/**
 * POST /api/ops/shipments/clear-send — «تحقّقتُ مع الشركة — لا طرد عندهم».
 *
 * The way out of a send that timed out. The claim written before the call is
 * kept on a silence (the parcel may exist), and nothing cleared it, so the
 * order stayed «الإرسال قيد التنفيذ» for ever. A person who has asked the
 * company and heard that they hold no parcel presses this; it clears the
 * claim and the barcode so the order can be sent again.
 *
 * It is a person's word, so it is recorded with their name and the sentence
 * they typed, on the order and in the audit. The rules of when it refuses
 * are in `lib/couriers/send-reset.ts`.
 */

const schema = z.object({
  orderId: z.string().uuid(),
  /** What the company said, in the person's own words. */
  note: z.string().trim().min(5, 'اكتب ما قالته الشركة — خمسة أحرف على الأقل').max(300),
  /** The barcode, typed back, when the order carries one. */
  confirmBarcode: z.string().trim().max(120).optional(),
});

const STATUS = {
  NOT_FOUND: 404,
  NO_CLAIM: 409,
  TOO_SOON: 409,
  ALREADY_LEFT: 409,
  ALREADY_SENT: 409,
  BARCODE_CONFIRM_REQUIRED: 409,
  MOVED_ON: 409,
} as const;

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.ship');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { orderId, note, confirmBarcode } = parsed.data;

    const result = await clearStuckSend({ orderId, companyId, storeId, confirmBarcode });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, errorAr: result.message, code: result.code, ...(result.barcode ? { barcode: result.barcode } : {}) },
        { status: STATUS[result.code] }
      );
    }

    await db.orderActivity.create({
      data: {
        companyId,
        orderId,
        userId: user.id,
        action: 'COURIER_SEND_CLEARED',
        metadata: JSON.stringify({ clearedBarcode: result.clearedBarcode, said: note }),
      },
    });
    await logAudit({
      companyId, userId: user.id, action: 'COURIER_SEND_CLEARED',
      entity: 'Order', entityId: orderId,
      previousData: { trackingNumber: result.clearedBarcode, sendInFlight: true },
      newData: { said: note, by: user.name },
    });

    return NextResponse.json({ success: true, orderNumber: result.orderNumber });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
