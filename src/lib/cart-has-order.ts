import { db } from './db';
import { logAudit } from './audit';
import { ordersBehindCarts } from './abandoned-carts';
import { AUTO_ORDER_BACKLOG_DAYS, SELF_CLOSE_STATUSES, cartHasOrderNote } from './abandoned-cart-rules';

/**
 * «له طلب» → «طلب لحاله»: A CART WHOSE CUSTOMER ALREADY HAS AN ORDER CLOSES ITSELF (the owner, 21/11).
 *
 * The owner's screenshot: one customer, two carts five minutes apart, both «جديدة», both «له طلب» — and the team still
 * ringing him. When the cart's phone already has an order for the same product of this company in the last
 * `HAS_ORDER_DAYS` days (exactly what `ordersBehindCarts` matches for the «له طلب» badge), the cart is not left open: it
 * becomes RECOVERED, pointing at that order, with a history line in nobody's name («الزبون عنده طلب #… — تسكّرت لحالها»)
 * and an audit row (`userId` null, `via: has-order`) — the shape `cartsRecoveredBy` and the landing door's `/recovered`
 * write.
 *
 * ── WHICH CARTS ──
 *
 *   · NEW only (`SELF_CLOSE_STATUSES`) — and not one a person put back to NEW by hand. A status a person set is the team's
 *     word: «غير مهتم», «رقم غير صالح», CONTACTED, CALLBACK, … are never touched.
 *   · With a product of this company. `ordersBehindCarts` flags a cart whose product is unknown here against ANY order —
 *     the safer mistake for a badge, the wrong one for closing a cart — so such a cart stays open with its badge.
 *   · Not yet an order (`orderId` null). The write is conditional on all of that, so a person's press in the same second
 *     wins.
 *
 * ── WHERE ──
 *
 * At the landing door's upsert, before the automatic order — whatever the company's switch says, because this makes no
 * order — and in the job's sweep (`closeOrderedCarts`), for the carts already sitting in the list.
 */

type OpenCart = { id: string; status: string; phoneNormalized: string; productId: string | null };

const CART_FIELDS = { id: true, status: true, phoneNormalized: true, productId: true } as const;

/** The carts among these that a person moved by hand at least once — their status is the team's, whatever it reads. */
async function setByHand(companyId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const lines = await db.abandonedCartActivity.findMany({
    where: { companyId, cartId: { in: ids }, userId: { not: null }, action: 'STATUS_CHANGED' },
    select: { cartId: true },
  });
  return new Set(lines.map((l) => l.cartId));
}

/**
 * CLOSE EACH OF THESE CARTS WHOSE CUSTOMER ALREADY HAS AN ORDER. Returns the carts closed, each with its order. Throws
 * on a database fault — the callers decide (`closeCartIfOrdered` swallows it, the job counts it).
 */
export async function closeCartsWithOrders(
  companyId: string,
  carts: ReadonlyArray<OpenCart>,
  now: Date
): Promise<Map<string, { id: string; orderNumber: string }>> {
  const closed = new Map<string, { id: string; orderNumber: string }>();
  const candidates = carts.filter((c) => (SELF_CLOSE_STATUSES as string[]).includes(c.status) && !!c.productId && !!c.phoneNormalized);
  if (candidates.length === 0) return closed;

  const behind = await ordersBehindCarts(companyId, candidates, now);
  if (behind.size === 0) return closed;
  const byHand = await setByHand(companyId, [...behind.keys()]);

  for (const cart of candidates) {
    const order = behind.get(cart.id);
    if (!order || byHand.has(cart.id)) continue;
    const won = await db.abandonedCart.updateMany({
      where: { id: cart.id, companyId, status: { in: SELF_CLOSE_STATUSES }, orderId: null },
      data: { status: 'RECOVERED', orderId: order.id },
    });
    if (won.count !== 1) continue;
    await db.abandonedCartActivity.create({
      data: {
        companyId,
        cartId: cart.id,
        userId: null,
        action: 'RECOVERED',
        fromStatus: cart.status,
        toStatus: 'RECOVERED',
        note: cartHasOrderNote(order.orderNumber),
        metadata: JSON.stringify({ orderId: order.id, orderNumber: order.orderNumber, hasOrder: true }),
      },
    });
    await logAudit({
      companyId,
      userId: null,
      action: 'ABANDONED_CART_RECOVERED',
      entity: 'AbandonedCart',
      entityId: cart.id,
      previousData: { status: cart.status },
      newData: { status: 'RECOVERED', orderId: order.id, orderNumber: order.orderNumber, via: 'has-order' },
    });
    closed.set(cart.id, order);
  }
  return closed;
}

/**
 * THE LANDING DOOR'S HALF: the one cart it just wrote. Never throws — the door must answer Zaki pages whatever happens
 * here; a fault leaves the cart open, and the job's sweep asks again.
 */
export async function closeCartIfOrdered(
  companyId: string,
  cartId: string,
  now: Date
): Promise<{ id: string; orderNumber: string } | null> {
  try {
    const cart = await db.abandonedCart.findFirst({ where: { id: cartId, companyId }, select: CART_FIELDS });
    if (!cart) return null;
    return (await closeCartsWithOrders(companyId, [cart], now)).get(cart.id) ?? null;
  } catch (e) {
    console.error('[carts] has-order check failed (non-fatal):', (e as Error)?.name || 'unknown');
    return null;
  }
}

/** A batch of carts read at once, and the most read in one run. */
const SWEEP_BATCH = 200;
const SWEEP_MAX = 1000;

/**
 * THE JOB'S HALF: THE CARTS ALREADY SITTING IN THE LIST (`convert-waiting-carts`).
 *
 * NEW carts with a product, not yet an order, seen in the last `AUTO_ORDER_BACKLOG_DAYS` days — including those whose
 * automatic order was already tried and skipped as «له طلب» (`autoOrderAt` set), like the two in the owner's screenshot.
 * Newest first, in batches of `SWEEP_BATCH`, `SWEEP_MAX` at most a run. Every company, whatever its switch: this makes no
 * order. Idempotent: a closed cart is no longer NEW, and a cart with no order behind it is only read again.
 */
export async function closeOrderedCarts(now: Date): Promise<{ closed: number; checked: number }> {
  const since = new Date(now.getTime() - AUTO_ORDER_BACKLOG_DAYS * 24 * 60 * 60 * 1000);
  const open = {
    status: { in: SELF_CLOSE_STATUSES },
    orderId: null,
    productId: { not: null },
    lastSeenAt: { gte: since },
  };
  const companies = await db.abandonedCart.groupBy({ by: ['companyId'], where: open });
  const out = { closed: 0, checked: 0 };
  for (const { companyId } of companies) {
    let skip = 0;
    while (out.checked < SWEEP_MAX) {
      const take = Math.min(SWEEP_BATCH, SWEEP_MAX - out.checked);
      const batch = await db.abandonedCart.findMany({
        where: { companyId, ...open },
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
        select: CART_FIELDS,
      });
      if (batch.length === 0) break;
      out.checked += batch.length;
      const closed = await closeCartsWithOrders(companyId, batch, now);
      out.closed += closed.size;
      // The closed ones left the filter; the rest are still in it, so the next page starts after them.
      skip += batch.length - closed.size;
      if (batch.length < take) break;
    }
    if (out.checked >= SWEEP_MAX) break;
  }
  return out;
}
