import { db } from './db';
import { logAudit } from './audit';
import { endOrder } from './order-cancel';
import { intakePhoneKeys } from './intake-filter';
import { CONFIRMATION_STATUSES, TERMINAL_CONFIRMATION_STATUSES } from './confirmation-workflow';
import { CART_AUTO_ACTION, CART_ORDER_SOURCE, CUSTOMER_ORDERED_HIMSELF_AR } from './abandoned-cart-rules';

/**
 * THE CUSTOMER ORDERED BY HIMSELF — HIS ORDER WINS OVER THE ONE HIS CART BECAME (the owner, 17/11).
 *
 * An abandoned cart with a name and a phone becomes an order by itself (`abandoned-cart-orders.ts`). When the same
 * visitor then places the order on the landing page after all (same phone, same product, same store), two orders would
 * reach the queue for one purchase. The owner's ruling:
 *
 *   · the automatic order, while NOBODY HAS CONFIRMED IT, is ended — through `endOrder`, the one helper every door that
 *     ends an order goes through (stock released, status log, the customer's count, the event), as the desk's «رفض» with
 *     the reason the desk uses for a duplicate (`DUPLICATE_ORDER`) and the note «الزبون طلب بنفسه»; and the customer's
 *     own order is taken normally. The automatic order never refuses it: it was taken under its own one-order-per-phone
 *     slot (`cart:<id>`), never the page's;
 *   · an automatic order somebody already CONFIRMED is left alone, and the customer's order is taken exactly as today
 *     (the twin flags, and the confirmed-twin question at the next «تأكيد»).
 *
 * The cart then reads «طلب لحاله», pointing at the customer's own order (`cartsRecoveredBy`).
 *
 * NEVER IN THE WAY. Every step here is advice to the queue: a read or a write that fails is logged and the customer's
 * order goes through as it would have without this file.
 */

/** Whose name the ending carries. The status log needs a user, so — as at the landing chat — the company's administrator. */
export const CART_SYSTEM_ACTOR_AR = 'النظام (سلة مهجورة)';

/** Not confirmed and not ended: the statuses an automatic order may still be stood down from. */
const STILL_UNCONFIRMED = CONFIRMATION_STATUSES.filter((s) => !TERMINAL_CONFIRMATION_STATUSES.includes(s));

export interface CartOrder {
  id: string;
  orderNumber: string;
  version: number;
  cartIds: string[];
}

/**
 * The automatic orders this customer's order would replace: made from a cart, for this product in this store, by the
 * same person (the customer row is per company, store and phone; `intakePhoneKeys` reads every spelling of the number),
 * and not yet confirmed or ended.
 */
export async function replaceableCartOrders(
  companyId: string,
  q: { storeId: string; countryCode: string | null; phone: string; productId: string }
): Promise<CartOrder[]> {
  const keys = intakePhoneKeys(q.phone, q.countryCode);
  if (keys.length === 0) return [];
  const customers = await db.customer.findMany({
    where: { companyId, storeId: q.storeId, phone: { in: keys } },
    select: { id: true },
  });
  if (customers.length === 0) return [];
  const rows = await db.order.findMany({
    where: {
      companyId,
      storeId: q.storeId,
      customerId: { in: customers.map((c) => c.id) },
      source: CART_ORDER_SOURCE,
      confirmationStatus: { in: [...STILL_UNCONFIRMED] },
      abandonedCarts: { some: {} },
      OR: [{ productId: q.productId }, { items: { some: { productId: q.productId } } }],
    },
    select: { id: true, orderNumber: true, version: true, abandonedCarts: { select: { id: true } } },
  });
  return rows.map((o) => ({ id: o.id, orderNumber: o.orderNumber, version: o.version, cartIds: o.abandonedCarts.map((c) => c.id) }));
}

/** The user two tables need (`OrderStatusLog.changedById`): the company's active administrator. Null when there is none. */
async function bookkeepingActor(companyId: string): Promise<{ id: string; role: string } | null> {
  return (
    (await db.user.findFirst({ where: { companyId, role: 'COMPANY_ADMIN', status: 'ACTIVE' }, select: { id: true, role: true } })) ??
    (await db.user.findFirst({ where: { companyId, role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { id: true, role: true } }))
  );
}

/**
 * END EACH AUTOMATIC ORDER — «الزبون طلب بنفسه». Returns the ones that ended; one the helper refused (somebody confirmed
 * it a second ago, a version that moved) is left as it is, and the customer's order then meets it as a twin, as today.
 */
export async function standDownCartOrders(companyId: string, orders: CartOrder[]): Promise<CartOrder[]> {
  if (orders.length === 0) return [];
  const actor = await bookkeepingActor(companyId);
  if (!actor) return [];
  const ended: CartOrder[] = [];
  for (const o of orders) {
    const outcome = await endOrder({
      orderId: o.id,
      companyId,
      storeId: null,
      by: { id: actor.id, name: CART_SYSTEM_ACTOR_AR, role: actor.role },
      door: 'CONFIRMATION',
      kind: 'CANCEL',
      endAs: 'REJECTED',
      reason: 'DUPLICATE_ORDER',
      rejectionNote: CUSTOMER_ORDERED_HIMSELF_AR,
      logNote: `${CART_SYSTEM_ACTOR_AR}: ${CUSTOMER_ORDERED_HIMSELF_AR}`,
      noteBody: null,
      expectedVersion: o.version,
    });
    if (!outcome.ok) continue;
    ended.push(o);
    for (const cartId of o.cartIds) {
      await db.abandonedCartActivity.create({
        data: {
          companyId,
          cartId,
          userId: null,
          action: CART_AUTO_ACTION.STOOD_DOWN,
          note: CUSTOMER_ORDERED_HIMSELF_AR,
          metadata: JSON.stringify({ orderId: o.id, orderNumber: o.orderNumber }),
        },
      });
    }
    await logAudit({
      companyId,
      userId: null,
      action: 'ORDER_REJECTED',
      entity: 'Order',
      entityId: o.id,
      newData: { confirmationStatus: 'REJECTED', rejectionReason: 'DUPLICATE_ORDER', note: CUSTOMER_ORDERED_HIMSELF_AR, by: CART_SYSTEM_ACTOR_AR },
    });
  }
  return ended;
}

/**
 * The carts whose automatic order was ended now read «طلب لحاله» and point at the customer's own order — the status Zaki
 * pages' `/recovered` would have written, so its call, when it comes, is a repeat that changes nothing.
 */
export async function cartsRecoveredBy(companyId: string, ended: CartOrder[], orderNumber: string): Promise<void> {
  const order = await db.order.findFirst({ where: { companyId, orderNumber }, select: { id: true } });
  for (const o of ended) {
    for (const cartId of o.cartIds) {
      await db.abandonedCart.update({
        where: { id: cartId },
        data: {
          status: 'RECOVERED',
          orderId: order?.id ?? null,
          activities: {
            create: {
              companyId,
              userId: null,
              action: 'RECOVERED',
              fromStatus: 'CONVERTED',
              toStatus: 'RECOVERED',
              metadata: JSON.stringify({ orderNumber, replaced: o.orderNumber }),
            },
          },
        },
      });
    }
  }
}
