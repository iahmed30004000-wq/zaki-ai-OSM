import { db } from './db';
import { logAudit } from './audit';
import { isBlocked } from './blacklist';
import { cartAutoConvert, ordersBehindCarts } from './abandoned-carts';
import {
  AUTO_ORDER_BACKLOG_DAYS,
  AUTO_ORDER_SKIP_AR,
  AUTO_ORDER_STATUSES,
  CART_AUTO_ACTION,
  CART_ORDER_SOURCE,
  cartPhoneShown,
  cartQualifiesForOrder,
} from './abandoned-cart-rules';
import { FROM_ABANDONED_CART_ACTION } from './landing-order-schema';
import { takeCartOrder } from './v1/landing-door';

/**
 * «السلات المهجورة» → «الطلبات»: A CART WITH A NAME AND A PHONE BECOMES AN ORDER BY ITSELF (the owner, 17/11).
 *
 * «بدي السلات المهجورة تتحول لطلب مباشرة وتنبعت للطابور». WHICH carts and ONCE is decided here; the order itself is made
 * by the landing orders' own engine (`takeCartOrder` → `createPublicOrder`), never by a row written here.
 *
 * ── WHICH CART ──
 *
 * One whose product is this company's (`cartQualifiesForOrder`; its phone the landing door already checked), still open
 * and not closed by a person as «غير مهتم» or «رقم غير صالح» (`AUTO_ORDER_STATUSES`), with the company's switch on
 * (`abandonedCarts.autoConvert`, ON by default). Since 26/11 a phone-only cart qualifies too: its order is taken in the
 * name «بدون اسم» with a note to ask for it (`cartOrderName`), and the agent writes the name on the call.
 *
 * ── ONCE ──
 *
 * The cart is CLAIMED before anything is made: `autoOrderAt` goes from nothing to now by a conditional update only one
 * caller can win — the door's upsert and the job may reach the same cart in the same second, and two sends of one lead
 * under two keys do. The claim is never given back once an order may exist, so a re-sent cart, a second tick or a retry
 * makes no second order. If the engine threw before anything was saved, the claim IS given back and the job tries again.
 *
 * ── WHEN IT STAYS A CART ──
 *
 * The same phone already has an order for the same product this week («له طلب»), the number is blacklisted, the product
 * or its store is stopped, or the order door refused what the cart holds (a phone that is not the country's, …). The
 * cart stays in «السلات المهجورة» for the team, with the reason as a line of its history, and the claim stays: the
 * reason will not change by asking again every five minutes.
 *
 * Since 21/11 (the owner) a NEW cart whose customer already has an order does not reach this file as «له طلب»: the landing
 * door and the job close it first as «طلب لحاله», pointing at that order (`cart-has-order.ts`). The HAS_ORDER skip below
 * stays for the rest — a cart a person already worked (CONTACTED, CALLBACK, …), whose status is the team's.
 *
 * ── WHAT THE CART SAYS ──
 *
 * CONVERTED, pointing at the order, with a history line and an audit row in nobody's name (`userId` null, `via: auto`).
 */

export type AutoOrderOutcome =
  | { kind: 'CONVERTED'; orderId: string; orderNumber: string }
  | { kind: 'SKIPPED'; reason: keyof typeof AUTO_ORDER_SKIP_AR }
  | { kind: 'NONE' };

const NONE: AutoOrderOutcome = { kind: 'NONE' };

const CART_SELECT = {
  id: true,
  status: true,
  customerName: true,
  phone: true,
  phoneNormalized: true,
  country: true,
  productId: true,
  orderId: true,
  city: true,
  autoOrderAt: true,
  region: { select: { name: true } },
} as const;

type Cart = {
  id: string;
  status: string;
  customerName: string | null;
  phone: string;
  phoneNormalized: string;
  country: string | null;
  productId: string | null;
  orderId: string | null;
  city: string | null;
  autoOrderAt: Date | null;
  region: { name: string } | null;
};

/**
 * TRY TO TURN ONE CART INTO AN ORDER. Never throws: the landing door must answer Zaki pages whatever happens here, and
 * the job must go on to the next cart. `switchOn` is the company's switch when the caller already read it.
 */
export async function autoOrderForCart(
  companyId: string,
  cartId: string,
  opts: { now?: Date; switchOn?: boolean } = {}
): Promise<AutoOrderOutcome> {
  try {
    return await tryCart(companyId, cartId, opts.now ?? new Date(), opts.switchOn);
  } catch (e) {
    console.error('[carts] automatic order failed (non-fatal):', (e as Error)?.name || 'unknown');
    return NONE;
  }
}

async function tryCart(companyId: string, cartId: string, now: Date, switchOn?: boolean): Promise<AutoOrderOutcome> {
  const cart = (await db.abandonedCart.findFirst({ where: { id: cartId, companyId }, select: CART_SELECT })) as Cart | null;
  if (!cart || cart.autoOrderAt || !cartQualifiesForOrder(cart)) return NONE;
  if (!(switchOn ?? (await cartAutoConvert(companyId)))) return NONE;

  // THE CLAIM — one caller wins it, once.
  const claimed = await db.abandonedCart.updateMany({
    where: { id: cart.id, companyId, autoOrderAt: null, orderId: null, status: { in: AUTO_ORDER_STATUSES } },
    data: { autoOrderAt: now },
  });
  if (claimed.count !== 1) return NONE;

  try {
    const behind = await ordersBehindCarts(companyId, [cart], now);
    const had = behind.get(cart.id);
    if (had) return skip(companyId, cart.id, 'HAS_ORDER', { orderNumber: had.orderNumber });
    if (await isBlocked(db, companyId, cart.phone, cart.country)) return skip(companyId, cart.id, 'BLOCKED');

    const result = await takeCartOrder(companyId, {
      id: cart.id,
      productId: cart.productId!,
      customerName: cart.customerName ?? '',
      phone: cartPhoneShown(cart.phoneNormalized, cart.country) || cart.phone,
      city: cart.region?.name ?? '',
      typedCity: !cart.region && cart.city ? cart.city : null,
    });
    if (!result.ok) {
      if (result.status === 409) return skip(companyId, cart.id, 'UNAVAILABLE');
      return skip(companyId, cart.id, 'REFUSED', { said: refusalWords(result.body) });
    }

    const order = await db.order.findFirst({
      where: { companyId, orderNumber: String(result.body.orderNumber) },
      select: { id: true, orderNumber: true },
    });
    if (!order) return NONE;
    await markConverted(companyId, cart, order);
    return { kind: 'CONVERTED', orderId: order.id, orderNumber: order.orderNumber };
  } catch (e) {
    // The order may have been saved before something after it threw: then it is this cart's, and it is tied.
    const made = await orderMadeFor(companyId, cart.id).catch(() => null);
    if (made) {
      await markConverted(companyId, cart, made);
      return { kind: 'CONVERTED', orderId: made.id, orderNumber: made.orderNumber };
    }
    // Nothing was saved: the claim goes back, and the job asks again on its next tick.
    await db.abandonedCart
      .updateMany({ where: { id: cart.id, companyId, autoOrderAt: now, orderId: null }, data: { autoOrderAt: null } })
      .catch(() => undefined);
    throw e;
  }
}

/**
 * The order the engine made for this cart, found by the line it wrote in the order's own transaction — matched whole
 * (`public-order.ts` writes exactly `{ cartId }`), never as a search.
 */
async function orderMadeFor(companyId: string, cartId: string): Promise<{ id: string; orderNumber: string } | null> {
  return db.order.findFirst({
    where: {
      companyId,
      source: CART_ORDER_SOURCE,
      activities: { some: { action: FROM_ABANDONED_CART_ACTION, metadata: JSON.stringify({ cartId }) } },
    },
    select: { id: true, orderNumber: true },
  });
}

async function markConverted(companyId: string, cart: Cart, order: { id: string; orderNumber: string }) {
  await db.abandonedCart.update({
    where: { id: cart.id },
    data: {
      status: 'CONVERTED',
      orderId: order.id,
      activities: {
        create: {
          companyId,
          userId: null,
          action: 'CONVERTED',
          fromStatus: cart.status,
          toStatus: 'CONVERTED',
          metadata: JSON.stringify({ orderId: order.id, orderNumber: order.orderNumber, auto: true }),
        },
      },
    },
  });
  await logAudit({
    companyId,
    userId: null,
    action: 'ABANDONED_CART_CONVERTED',
    entity: 'AbandonedCart',
    entityId: cart.id,
    previousData: { status: cart.status },
    newData: { status: 'CONVERTED', orderId: order.id, orderNumber: order.orderNumber, via: 'auto' },
  });
}

async function skip(
  companyId: string,
  cartId: string,
  reason: keyof typeof AUTO_ORDER_SKIP_AR,
  extra: { orderNumber?: string; said?: string } = {}
): Promise<AutoOrderOutcome> {
  const words = reason === 'REFUSED' && extra.said ? `${AUTO_ORDER_SKIP_AR.REFUSED}: ${extra.said}` : AUTO_ORDER_SKIP_AR[reason];
  await db.abandonedCartActivity.create({
    data: {
      companyId,
      cartId,
      userId: null,
      action: CART_AUTO_ACTION.SKIPPED,
      note: words.slice(0, 1000),
      metadata: JSON.stringify({ reason, ...(extra.orderNumber ? { orderNumber: extra.orderNumber } : {}) }),
    },
  });
  return { kind: 'SKIPPED', reason };
}

/** The door's own Arabic: its sentence and its field errors — never anything the visitor typed. */
function refusalWords(body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof body.error === 'string') parts.push(body.error);
  const fields = body.fieldErrors;
  if (fields && typeof fields === 'object') {
    for (const v of Object.values(fields as Record<string, unknown>)) if (typeof v === 'string') parts.push(v);
  }
  return [...new Set(parts)].join(' ').slice(0, 500);
}

/**
 * THE CARTS THAT WAITED — those sent before this release, or while the switch was off, or whose try was given back.
 *
 * The job's half (`convert-waiting-carts`): a few at a time, oldest first, only in companies whose switch is on, and
 * only carts seen in the last `AUTO_ORDER_BACKLOG_DAYS` days — a visitor from a month ago is a call for the team, not an
 * order nobody remembers placing. Each goes through `autoOrderForCart`, the same claim and the same engine as the door.
 */
export async function convertWaitingCarts(now: Date, limit = 20): Promise<{ converted: number; skipped: number; tried: number }> {
  const since = new Date(now.getTime() - AUTO_ORDER_BACKLOG_DAYS * 24 * 60 * 60 * 1000);
  const waiting = {
    autoOrderAt: null,
    orderId: null,
    status: { in: AUTO_ORDER_STATUSES },
    productId: { not: null },
    lastSeenAt: { gte: since },
  };
  const companies = await db.abandonedCart.groupBy({ by: ['companyId'], where: waiting });
  const out = { converted: 0, skipped: 0, tried: 0 };
  for (const { companyId } of companies) {
    if (out.tried >= limit) break;
    if (!(await cartAutoConvert(companyId))) continue;
    const carts = await db.abandonedCart.findMany({
      where: { companyId, ...waiting },
      orderBy: { lastSeenAt: 'asc' },
      take: (limit - out.tried) * 3,
      select: { id: true, status: true, customerName: true, productId: true, orderId: true },
    });
    for (const c of carts) {
      if (out.tried >= limit) break;
      if (!cartQualifiesForOrder(c)) continue;
      out.tried++;
      const done = await autoOrderForCart(companyId, c.id, { now, switchOn: true });
      if (done.kind === 'CONVERTED') out.converted++;
      else if (done.kind === 'SKIPPED') out.skipped++;
    }
  }
  return out;
}
