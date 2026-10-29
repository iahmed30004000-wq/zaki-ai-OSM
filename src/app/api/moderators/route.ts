import { CONFIRMATION_REFUSED, DELIVERED_SHIPPING, rateOf } from '@/lib/order-state';
import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { commissionByUserForOrders } from '@/lib/commission';
import { notSuperseded } from '@/lib/superseded';

export async function GET() {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('users.view');

    const moderators = await db.user.findMany({
      where: {
        companyId,
        role: 'MODERATOR',
      },
      include: {
        assignedOrders: {
          // A replaced order is not a second order of hers: the replacement
          // carries her name now (src/lib/superseded.ts).
          where: notSuperseded,
          select: {
            id: true,
            orderNumber: true,
            // The two real columns. The legacy merged `status` is not written
            // by the courier feed or by the door-side partial-delivery
            // recorder, so every count below read from it was blind to the
            // orders those two paths finished.
            confirmationStatus: true,
            shippingStatus: true,
            totalAmount: true,
            collectedAmount: true,
            createdAt: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // One grouped read for everybody, rather than a query per moderator.
    // Scoped on `shippingStatus`, which is the column the ledger itself
    // accrues on (`accrueForOrder` refuses anything but DELIVERED there).
    // The legacy combined `status` is NOT synced by every path that
    // delivers an order — the courier webhook writes `shippingStatus` alone
    // — so filtering on it here would silently drop the commission on every
    // order a courier feed delivered.
    const commissionByUser = await commissionByUserForOrders({ companyId, shippingStatus: 'DELIVERED' });

    const enriched = moderators.map((mod) => {
      const orders = mod.assignedOrders;
      const totalOrders = orders.length;
      // Ever confirmed — it stays true after the parcel ships, which is what
      // a delivery rate has to be measured against.
      const confirmedOrders = orders.filter((o) => o.confirmationStatus === 'CONFIRMED').length;
      // A confirmation refusal only: a parcel that came back is not this
      // person refusing to confirm, and RETURNED here blamed them for it.
      const rejectedOrders = orders.filter((o) =>
        (CONFIRMATION_REFUSED as readonly string[]).includes(o.confirmationStatus)
      ).length;
      const postponedOrders = orders.filter((o) =>
        ['POSTPONED', 'FOLLOW_UP_REQUIRED'].includes(o.confirmationStatus)
      ).length;
      const delivered = orders.filter((o) =>
        (DELIVERED_SHIPPING as readonly string[]).includes(o.shippingStatus)
      );
      const deliveredOrders = delivered.length;

      // What was actually collected where the door recorded it — the same
      // rule the profit screen uses. A partial delivery is the case where
      // the collected figure and the order total differ.
      const sales = delivered.reduce((sum, o) => sum + Number(o.collectedAmount ?? o.totalAmount), 0);

      // The ledger's figure for this person, not a sum of the legacy column.
      const commissions = Number((commissionByUser.get(mod.id) ?? 0).toFixed(2));

      // Out of what was DECIDED. Dividing by everything assigned counted the
      // orders still sitting in this person's queue as failures, so the rate
      // fell as the queue grew — it measured the backlog, not the work.
      const decidedOrders = confirmedOrders + rejectedOrders;
      const confirmationRate = rateOf(confirmedOrders, decidedOrders) ?? 0;
      const rejectionRate = rateOf(rejectedOrders, decidedOrders) ?? 0;
      const deliveryRate = rateOf(deliveredOrders, confirmedOrders) ?? 0;

      return {
        id: mod.id,
        name: mod.name,
        email: mod.email,
        phone: mod.phone,
        status: mod.status,
        commissionRate: mod.commissionRate,
        stats: {
          totalOrders,
          confirmedOrders,
          rejectedOrders,
          postponedOrders,
          deliveredOrders,
          confirmationRate,
          rejectionRate,
          deliveryRate,
          sales: Number(sales.toFixed(2)),
          commissions: Number(commissions.toFixed(2)),
        },
      };
    });

    // Rank by confirmed orders
    enriched.sort((a, b) => b.stats.confirmedOrders - a.stats.confirmedOrders);

    return NextResponse.json({ moderators: enriched });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

/**
 * POST /api/moderators — CLOSED (410), and why it is closed rather than fixed.
 *
 * It created an ACTIVE moderator on «إنشاء المستخدمين» alone, and was the
 * second door for that: `POST /api/users` checks that the creator holds every
 * key the role carries (canConferRole), checks the password's strength, and
 * records who placed the account. This one did none of it — and answered
 * with the whole new row, password hash included. Nothing calls it any more
 * (the order form only reads the list, with GET above), so it answers 410
 * with where to go, and the git history keeps what it was.
 */
export async function POST() {
  try {
    await requireCompanyTenant();
    return NextResponse.json(
      {
        error: 'هالباب انسكّر — الموظف الجديد من شاشة «الموظفين».',
        errorAr: 'هالباب انسكّر — الموظف الجديد من شاشة «الموظفين».',
        code: 'GONE',
      },
      { status: 410 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
