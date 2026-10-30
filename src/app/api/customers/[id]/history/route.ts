import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { requireContext } from '@/lib/geo-context';
import { getPermissionScope } from '@/lib/authorization';
import { assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR, mayEnterOrderWorkDoor } from '@/lib/order-work-door';
import { apiErrorResponse } from '@/lib/api-error';
import { customerRisk } from '@/lib/customer-risk';
import { mayReadInsights } from '@/lib/insights-key';
import { deriveCoreState, type StateSource } from '@/lib/order-state';
import { noteCustomersHandedOut } from '@/lib/pii-alert';

/**
 * GET /api/customers/:id/history?exclude=<orderId>
 *
 * Everything the agent needs to know before calling: did this person order
 * before, what happened to those orders, and what their risk tier is. The
 * customer is company-wide (one phone, one person, one history), so the
 * list is NOT scoped to the selected store — an order returned in another
 * store is still a returned order.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    /*
     * WHOSE HISTORY, BY WHICH DOOR.
     *
     * Any of three keys used to open any customer in the store, scope or no
     * scope: an agent with orders ASSIGNED, or the address book's OWN, typed
     * an id and read thirty orders with their refusal reasons. The history
     * is read two ways, and each is now held to its own rule:
     *
     *   • the address book (`customers.view`), within its scope — OWN is the
     *     customers this person brought in, as the customers list counts it;
     *   • from an order (every button passes `?exclude=<that order>`): the
     *     order must be one this person can open, and this its customer.
     *     «Can open» is the work door's answer (order-work-door.ts), so the
     *     agent holding the order reads its customer without «عرض الطلبات».
     */
    const exclude = new URL(req.url).searchParams.get('exclude');
    const book = getPermissionScope(user, 'customers.view');
    let allowed = false;
    if (book?.scope === 'OWN') {
      allowed = !!(await db.order.findFirst({
        where: { companyId, customerId: id, moderatorId: user.id },
        select: { id: true },
      }));
    } else if (book) {
      allowed = true;
    }
    if (!allowed && exclude && mayEnterOrderWorkDoor(user)) {
      const access = await assertOrderReadable(exclude, user, { companyId, storeId }, ORDER_WORK_DOOR);
      if (access.allowed) {
        const theirs = await db.order.findFirst({ where: { id: exclude, customerId: id }, select: { id: true } });
        allowed = !!theirs;
      }
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden: cannot read customer history', errorAr: 'سجلّ العميل ليس من صلاحيّاتك.' }, { status: 403 });
    }

    const customer = await db.customer.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      select: {
        id: true, fullName: true, phone: true, rawPhone: true, city: true,
        totalOrders: true, deliveredOrders: true, cancelledOrders: true,
        firstOrderDate: true, lastOrderDate: true,
      },
    });
    if (!customer) return NextResponse.json({ error: 'العميل غير موجود' }, { status: 404 });

    const orders = await db.order.findMany({
      // The customer is this store's; their orders must be too. A
      // customer who bought from two stores has two histories, and neither
      // store is entitled to the other's.
      where: { ...inStore(companyId, storeId), customerId: id, ...(exclude ? { id: { not: exclude } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, orderNumber: true, merchantRef: true, createdAt: true, deliveredAt: true, returnedAt: true,
        confirmationStatus: true, shippingStatus: true, claimedById: true, shippedAt: true,
        totalAmount: true, currency: true, rejectionReason: true, returnReason: true,
        store: { select: { name: true } },
        items: { select: { productName: true, quantity: true, freeQuantity: true } },
      },
    });

    // The return-risk tier is a smart card (PR-10): ABSENT without `insights.view`, and the lookup is not made.
    const risk = mayReadInsights(user) ? await customerRisk(db, companyId, id) : undefined;

    /*
     * One person's contact details — and the same tally the list feeds.
     * Counted here too, or the hole is obvious: open five hundred profiles
     * one at a time and the list endpoint never sees any of it.
     */
    await noteCustomersHandedOut({
      companyId, storeId, user, where: 'ملفّات العملاء', rows: [{ customerId: id }],
    });

    return NextResponse.json({
      customer,
      ...(risk ? { risk } : {}),
      count: orders.length,
      orders: orders.map((o) => ({
        ...o,
        // The same derived state the order screens show — never the legacy field.
        state: deriveCoreState(o as StateSource),
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
