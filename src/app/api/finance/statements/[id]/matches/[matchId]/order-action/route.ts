import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import {
  NOT_MENTIONED_ACTIONS,
  NOT_MENTIONED_ACTIVITY,
  NOT_MENTIONED_AR,
  mayCorrectStatus,
  type NotMentionedAction,
} from '@/lib/not-mentioned';
import { isNotMentioned } from '@/lib/settlement-difference';

/**
 * POST /api/finance/statements/:id/matches/:matchId/order-action
 *
 * What a person decided about a parcel we delivered that no statement names («طلبات لم يذكرها أي كشف»):
 * wait for a later statement, ask the company for it, or say it was never delivered. See `lib/not-mentioned`
 * for what each one means.
 *
 * ── IT RECORDS, IT DOES NOT DO ──
 *
 * One `OrderActivity` on the ORDER and one audit row — nothing else. It writes no status, no figure, no
 * wallet movement and no settlement, and it adds no door that changes an order's state: «لم يُسلَّم» only
 * records that the status needs correcting, and the correction itself is made on the order, through the
 * shipping door that already exists for it («orders.unlock» and a written reason).
 *
 * ── WHO MAY ──
 *
 * The same permission as the screen it is pressed on and as the difference answer next to it:
 * `settlement.review`. The third action asks for `orders.unlock` as well, because a button that leads to a
 * correction its owner is not allowed to make would be a button with nowhere to go.
 */
const schema = z.object({
  action: z.enum(NOT_MENTIONED_ACTIONS),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const { id, matchId } = await params;
    const { user, companyId, storeId } = await requireContext();
    const actor = await requirePermission('settlement.review');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const action = parsed.data.action as NotMentionedAction;

    const match = await db.settlementMatch.findFirst({
      where: { id: matchId, statementId: id, companyId, statement: { storeId } },
      select: {
        id: true,
        result: true,
        orderId: true,
        statement: { select: { reference: true } },
        order: { select: { id: true, orderNumber: true, shippingStatus: true, storeId: true } },
      },
    });
    if (!match) return NextResponse.json({ error: 'سطر المطابقة غير موجود' }, { status: 404 });

    // Only the group this answer belongs to. A line that has an order and a figure is answered with
    // «رقمنا / رقمهم», and a line with no order has nothing to record the answer on.
    if (!isNotMentioned(match) || !match.order) {
      return NextResponse.json(
        { error: 'هذا الإجراء لطلب سُلِّم ولم يذكره أي كشف فقط', code: 'NOT_AN_UNMENTIONED_ORDER' },
        { status: 409 }
      );
    }
    if (match.order.storeId !== storeId) {
      return NextResponse.json({ error: 'سطر المطابقة غير موجود' }, { status: 404 });
    }

    if (action === 'NOT_DELIVERED' && !mayCorrectStatus({ holdsUnlock: can(actor, 'orders.unlock'), shippingStatus: match.order.shippingStatus })) {
      return NextResponse.json(
        {
          error: 'تصحيح حالة طلب مُسلَّم يحتاج صلاحية «فتح الطلبات المقفلة»، ولا باب غيره لذلك',
          code: 'NO_DOOR_TO_CORRECT_STATUS',
        },
        { status: 403 }
      );
    }

    const code = NOT_MENTIONED_ACTIVITY[action];
    // Pressed twice on the same row is one record, not two: the second press finds the first. Found by the row
    // it was pressed on (two statements may each name the order), read from the stored JSON — not searched as text.
    const earlier = await db.orderActivity.findMany({
      where: { companyId, orderId: match.order.id, action: code },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, createdAt: true, metadata: true },
    });
    const already = earlier.find((a) => {
      try {
        return (JSON.parse(a.metadata ?? '{}') as { matchId?: string }).matchId === match.id;
      } catch {
        return false;
      }
    });
    if (already) {
      return NextResponse.json({
        activity: { id: already.id, createdAt: already.createdAt },
        repeated: true,
        message: `${NOT_MENTIONED_AR[action]} — مسجَّل من قبل`,
      });
    }

    const activity = await db.orderActivity.create({
      data: {
        companyId,
        orderId: match.order.id,
        userId: user.id,
        action: code,
        metadata: JSON.stringify({
          matchId: match.id,
          statement: match.statement.reference,
          answer: NOT_MENTIONED_AR[action],
          ...(parsed.data.note ? { note: parsed.data.note } : {}),
        }),
      },
      select: { id: true, createdAt: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'STATEMENT_UNMENTIONED_ORDER_ANSWERED',
      entity: 'Order',
      entityId: match.order.id,
      newData: { action, statement: match.statement.reference, orderNumber: match.order.orderNumber },
    });

    return NextResponse.json({
      activity,
      repeated: false,
      message: `${NOT_MENTIONED_AR[action]} — ${match.order.orderNumber}`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
