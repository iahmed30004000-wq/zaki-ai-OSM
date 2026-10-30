import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { assertOrderAccess } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { apiErrorResponse } from '@/lib/api-error';
import { createNotification } from '@/lib/notification';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { noteCustomersHandedOut } from '@/lib/pii-alert';

/**
 * ENTRY ISSUES — data errors on orders a MODERATOR entered.
 *
 *   GET  /api/confirmation/issues
 *   POST /api/confirmation/issues   { orderId, reason, note }
 *
 * A store-sourced order (landing page, Telegram, POS) can never raise an
 * entry issue: there is no moderator to return it to. An issue is never
 * counted as a cancellation against the agent, and the order keeps its
 * original created_at — it returns to the queue, it is not recreated.
 */

export const ISSUE_REASONS = [
  'WRONG_PHONE', 'WRONG_ADDRESS', 'WRONG_PRODUCT', 'MISSING_DATA', 'DUPLICATE', 'OTHER',
] as const;

/** The reason in words, for the message that goes to the people who fix it. */
export const ISSUE_REASON_AR: Record<string, string> = {
  WRONG_PHONE: 'رقم خاطئ',
  WRONG_ADDRESS: 'عنوان خاطئ',
  WRONG_PRODUCT: 'منتج خاطئ',
  MISSING_DATA: 'بيانات ناقصة',
  DUPLICATE: 'طلب مكرّر',
  OTHER: 'سبب آخر',
};

const createSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.enum(ISSUE_REASONS),
  note: z.string().trim().max(500).optional(),
});

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.issues');

    const status = new URL(req.url).searchParams.get('status') ?? 'OPEN';
    const rows = await db.orderIssue.findMany({
      where: { companyId, ...(status === 'all' ? {} : { status }), order: { storeId } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: {
        order: {
          select: {
            id: true, orderNumber: true, merchantRef: true, createdAt: true, source: true,
            confirmationStatus: true, moderatorId: true,
            // The screen corrects the data in place, so it needs the values it
            // is about to overwrite — and the version, because the correction
            // saves through the ordinary order edit and that takes the same
            // lost-update guard as every other edit.
            version: true,
            regionId: true,
            region: { select: { id: true, name: true } },
            product: { select: { name: true } },
            quantity: true,
            customer: {
              select: { id: true, fullName: true, phone: true, rawPhone: true, altPhone: true, city: true, address: true },
            },
            moderator: { select: { id: true, name: true } },
          },
        },
      },
    });
    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'مشاكل التأكيد', rows });

    return NextResponse.json({ count: rows.length, issues: rows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    // RAISING an issue is its own box (`confirmation.raise_issue`, PR-7): it needs no list, and the agent whose desk holds
    // the button was never given the list. Reading the list keeps `confirmation.issues`.
    await requirePermission('confirmation.raise_issue');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // «إدخال إشكال» on the order she holds, from her own desk — the work door
    // (order-work-door.ts). A moderator holds no `confirmation.work`, so his
    // reach here is his orders.view scope, exactly as before.
    const access = await assertOrderAccess(parsed.data.orderId, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });
    const order = access.order;

    // Moderator-entered orders only.
    if (!order.moderatorId) {
      return NextResponse.json(
        {
          error: 'لا يمكن فتح إشكال إدخال على طلب من مصدر خارجي — لا يوجد مودريتور لإعادته إليه',
          code: 'NOT_MODERATOR_ENTERED',
        },
        { status: 409 }
      );
    }

    const existing = await db.orderIssue.findFirst({ where: { orderId: order.id, status: 'OPEN' }, select: { id: true } });
    if (existing) {
      return NextResponse.json({ error: 'يوجد إشكال مفتوح على هذا الطلب', code: 'ISSUE_OPEN' }, { status: 409 });
    }

    const issue = await db.$transaction(async (tx) => {
      const created = await tx.orderIssue.create({
        data: {
          companyId,
          orderId: order.id,
          raisedById: user.id,
          reason: parsed.data.reason,
          note: parsed.data.note ?? null,
        },
      });
      // The order leaves the agent's hands and waits for the moderator; its
      // created_at is untouched, and no cancellation is recorded anywhere.
      await tx.order.update({
        where: { id: order.id },
        data: {
          claimedById: null,
          claimedAt: null,
          currentOwnerId: null,
          confirmationStatus: 'NEW',
          status: 'NEW',
          signatureStatus: 'UNSIGNED',
          version: { increment: 1 },
        },
      });
      await tx.orderNote.create({
        data: {
          companyId,
          orderId: order.id,
          authorId: user.id,
          kind: 'internal',
          body: `إشكال إدخال (${parsed.data.reason})${parsed.data.note ? `: ${parsed.data.note}` : ''}`,
        },
      });
      return created;
    });

    await logAudit({
      companyId, userId: user.id, action: 'ORDER_ISSUE_RAISED',
      entity: 'Order', entityId: order.id, newData: { issueId: issue.id, reason: parsed.data.reason },
    });

    /**
     * AND SOMEBODY IS TOLD.
     *
     * Raising an issue told NOBODY. The order went back to the pool marked as
     * having a problem, and then waited for whoever happened to open the
     * issues screen next — which, for an order that a customer is waiting on,
     * is the wrong kind of patience.
     *
     * Two audiences in one call, because the union is what the situation is:
     *
     *   THE MODERATOR WHO ENTERED IT, by name. They typed the wrong number or
     *   picked the wrong product; they are the one who can say what was meant.
     *   Named explicitly because a moderator holds `confirmation.issues` for
     *   their own work and there may be several — only this one is involved.
     *
     *   AND EVERYONE WHO CAN ACT ON AN ISSUE, which now includes the follow-up
     *   agent. Waiting for one person to come back from lunch is how a
     *   correctable order becomes a late one.
     *
     * A failed notification never fails the issue: the issue is the record,
     * the message is the courtesy.
     */
    await createNotification({
      companyId,
      storeId: order.storeId,
      audience: {
        permission: 'confirmation.issues',
        userIds: order.moderatorId ? [order.moderatorId] : [],
      },
      type: 'SYSTEM_ALERT',
      title: 'إشكال إدخال على طلب',
      message:
        `الطلب ${order.orderNumber} رجع بإشكال: ${ISSUE_REASON_AR[parsed.data.reason] ?? parsed.data.reason}` +
        `${parsed.data.note ? ` — ${parsed.data.note}` : ''}. صحّحه ليعود إلى الطابور.`,
      link: `/confirmation/issues?order=${order.id}`,
    }).catch(() => {
      /* the issue is recorded either way */
    });

    return NextResponse.json({ issue }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
