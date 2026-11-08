import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { requireContext } from '@/lib/geo-context';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { pullNextOrder } from '@/lib/confirmation-queue';
import { reserveReturningCustomers } from '@/lib/reserve-returning-customers';
import { db } from '@/lib/db';

/**
 * THE PULL RAN OUT OF TIME — SAY SO, AND SAY PRESS AGAIN (RV711).
 *
 * P2028 is Prisma's «transaction API error»: no connection within `maxWait`, or the pull's transaction still running at its
 * `timeout` (`PULL_TRANSACTION_OPTIONS`) — on a busy morning, waiting behind colleagues pulling the same customer. Nothing was
 * written (the transaction is rolled back), so pressing again is safe. Without this it fell to the shared mapper's 500
 * «حدث خطأ داخلي … أبلغ مدير النظام» for a condition that clears by itself.
 */
const QUEUE_BUSY_MESSAGE = 'الطابور مشغول لحظة — اضغط «اسحب» مرة تانية';

function ranOutOfTime(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028';
}

/**
 * POST /api/confirmation/pull — take the next order.
 *
 * Requires confirmation.pull, which moderators never hold: pulling orders is
 * not the moderator's job. Refusals are explicit (untouched order, caps,
 * empty queue) so the screen can say why instead of showing a dead button.
 */
export async function POST() {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('confirmation.pull');

    // A returning customer's order that has just arrived is held for the agent who worked him last BEFORE the pick — best-effort:
    // if the hold cannot be written the order is simply the shared queue's, as it was before holds existed.
    await reserveReturningCustomers({ companyId, storeId }).catch(() => 0);

    const result = await pullNextOrder(
      { companyId, storeId },
      { id: user.id, role: user.role },
      {
        workHoursStart: country.workHoursStart,
        workHoursEnd: country.workHoursEnd,
        weekendDays: country.weekendDays,
        timezone: country.timezone,
      }
    );

    if (!result.ok) {
      const refusal = result.refusal;
      return NextResponse.json(
        {
          error: refusal?.message,
          code: refusal?.code,
          autoReleased: result.released,
          // A refusal that is about an order names it, as the claim-by-id door does for `UNTOUCHED_ORDER` — so a screen that
          // reaches it on a stale tab (a pull pressed before she learned she owes calls: «الشغل أول») can open that order.
          ...(refusal && (refusal.code === 'UNTOUCHED_ORDER' || refusal.code === 'WORK_FIRST')
            ? { orderId: refusal.orderId, orderNumber: refusal.orderNumber }
            : {}),
          ...(refusal?.code === 'WORK_FIRST' ? { count: refusal.count } : {}),
        },
        { status: refusal?.code === 'QUEUE_EMPTY' ? 404 : 409 }
      );
    }

    const order = await db.order.findUnique({
      where: { id: result.orderId },
      select: {
        id: true, orderNumber: true, merchantRef: true, totalAmount: true, currency: true,
        confirmationStatus: true, createdAt: true,
        // The street THIS order goes to — see the same select in `mine`.
        deliveryAddress: true,
        customer: { select: { id: true, fullName: true, phone: true, rawPhone: true, city: true, address: true } },
        items: { select: { id: true, productName: true, quantity: true, freeQuantity: true, lineTotal: true } },
        // The customer's own additions after the order — see the same select in `mine`.
        addOns: { select: { id: true, productName: true, quantity: true, total: true } },
      },
    });

    // Pulling is the by-one path through the whole queue, so it counts
    // toward the same tally as the lists.
    await noteCustomersHandedOut({
      companyId, storeId, user, where: 'سحب طلب للتأكيد', rows: order ? [order] : [],
    });

    return NextResponse.json({ order, autoReleased: result.released }, { status: 201 });
  } catch (error) {
    if (ranOutOfTime(error)) {
      // 503 + Retry-After: refused for now, not for good — the same press a second later is the answer.
      // Still one line in the server log, so a morning of busy pulls (or a starved pool) is seen, not swallowed.
      console.warn('[confirmation/pull] QUEUE_BUSY (P2028):', error instanceof Error ? error.message : error);
      return NextResponse.json(
        { error: QUEUE_BUSY_MESSAGE, errorAr: QUEUE_BUSY_MESSAGE, code: 'QUEUE_BUSY' },
        { status: 503, headers: { 'Retry-After': '1' } }
      );
    }
    return apiErrorResponse(error);
  }
}
