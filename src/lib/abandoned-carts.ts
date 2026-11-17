import type { Prisma } from '@prisma/client';
import { db } from './db';
import { can, getPermissionScope } from './authorization';
import { logAudit } from './audit';
import { phoneKeys } from './phone-rules';
import { toLatinDigits } from './latin-digits';
import { typed } from './text-search';
import {
  HAND_STATUSES,
  HAS_ORDER_DAYS,
  autoConvertOf,
  isClosedCart,
  retentionDaysOf,
  type CartStatus,
} from './abandoned-cart-rules';
import type { SessionUser } from '@/types/auth';

/**
 * «السلات المهجورة» — WHO SEES A CART, WHO WORKS IT, AND WHAT EACH PRESS WRITES.
 *
 * ── THE SAME KEYS AS THE ORDERS ──
 *
 * No new permission. The owner's brief: «اللي بيشوف الطلبات بيشوف السلات». So seeing is `orders.view`, and its SCOPE
 * decides which carts, the way it decides which orders:
 *
 *   «كل الشركة»       every cart of the store;
 *   «المسندة إليه»    the carts assigned to her AND the ones nobody holds yet — the brief's «المعيّنة إله أو غير المعيّنة»
 *                     (a cart has no pool to pull from: the unassigned ones ARE the pool);
 *   «طلباتي المنشأة»  the carts assigned to him — nobody types a cart, so «his» can only mean assigned;
 *   no `orders.view`  nothing, and the screen is not in the menu.
 *
 * Working one is the order keys that already mean «I talk to customers about their order»: recording a call
 * (`orders.contact_log`), changing a confirmation status (`orders.confirm`) or editing an order (`orders.edit`). A note is
 * `orders.note` too. Assigning is `orders.assign`. «حوّل لطلب» needs `orders.create`, because the order door asks it.
 *
 * ── WHICH STORE ──
 *
 * The OMS works one store at a time. A cart belongs to its product's store; a cart whose product is unknown here belongs
 * to its country's stores (and one with no country either, to every store), so it is never lost to everybody.
 *
 * ── THE PHONE ──
 *
 * Shown exactly as an order's customer phone is: to whoever may see the cart, and counted against the person by
 * `noteCustomersHandedOut` like every list that hands out contact details.
 */

/** The carts this person may see, before the store and the filters — or null for none at all. */
export function cartVisibilityWhere(user: SessionUser): Prisma.AbandonedCartWhereInput | null {
  const scope = getPermissionScope(user, 'orders.view');
  if (!scope) return null;
  if (scope.scope === 'ALL_COMPANY') return {};
  if (scope.scope === 'ASSIGNED') return { OR: [{ assignedToId: user.id }, { assignedToId: null }] };
  if (scope.scope === 'OWN') return { assignedToId: user.id };
  // CATEGORY / SPECIFIC mean nothing for an order, so nothing for a cart either.
  return null;
}

/** The carts of the store being worked: its products', and those whose product is unknown here by country. */
export function cartStoreWhere(storeId: string, countryCode: string): Prisma.AbandonedCartWhereInput {
  return {
    OR: [
      { product: { storeId } },
      { productId: null, OR: [{ country: countryCode }, { country: null }] },
    ],
  };
}

export interface CartPowers {
  work: boolean;
  note: boolean;
  assign: boolean;
  convert: boolean;
  settings: boolean;
}

export function cartPowers(user: SessionUser): CartPowers {
  const work = can(user, 'orders.contact_log') || can(user, 'orders.confirm') || can(user, 'orders.edit');
  return {
    work,
    note: work || can(user, 'orders.note'),
    assign: can(user, 'orders.assign'),
    convert: work && can(user, 'orders.create'),
    settings: can(user, 'settings.edit'),
  };
}

/** One cart this person may see in this store, or null — never «exists but not yours». */
export async function findVisibleCart(
  user: SessionUser,
  ctx: { companyId: string; storeId: string; countryCode: string },
  id: string
) {
  const visible = cartVisibilityWhere(user);
  if (!visible) return null;
  return db.abandonedCart.findFirst({
    where: { id, companyId: ctx.companyId, AND: [visible, cartStoreWhere(ctx.storeId, ctx.countryCode)] },
    select: { id: true, status: true, assignedToId: true, orderId: true, attempts: true, nextFollowUpAt: true },
  });
}

/** The search box: a name, a product, or any part of the number in either digit script. */
export function cartSearchWhere(q: string): Prisma.AbandonedCartWhereInput {
  const latin = toLatinDigits(q).trim();
  const digits = latin.replace(/\D/g, '').replace(/^0+/, '');
  return {
    OR: [
      { customerName: typed(q) },
      { productName: typed(q) },
      { phone: typed(latin) },
      ...(digits.length >= 3 ? [{ phoneNormalized: typed(digits) }] : []),
    ],
  };
}

/**
 * «له طلب» — THE SAME PHONE ALREADY ORDERED THE SAME PRODUCT IN THE LAST SEVEN DAYS.
 *
 * So nobody rings a customer to sell him what he bought on Tuesday. The phone is matched the way a customer is
 * (`phoneKeys`: the stored national form and the whole international one), the product on the order's own column or
 * any of its lines. A cart whose product is unknown here is flagged by any order in the window — the safer mistake.
 * Read only for carts still open: a closed one already points at its order.
 */
export async function ordersBehindCarts(
  companyId: string,
  carts: ReadonlyArray<{ id: string; status: string; phoneNormalized: string; productId: string | null }>,
  now = new Date()
): Promise<Map<string, { id: string; orderNumber: string }>> {
  const open = carts.filter((c) => !isClosedCart(c.status) && c.phoneNormalized);
  const out = new Map<string, { id: string; orderNumber: string }>();
  if (open.length === 0) return out;

  const keysOf = new Map(open.map((c) => [c.id, phoneKeys(c.phoneNormalized)]));
  const allKeys = [...new Set([...keysOf.values()].flat())];
  const customers = await db.customer.findMany({
    where: { companyId, phone: { in: allKeys } },
    select: { id: true, phone: true },
  });
  if (customers.length === 0) return out;

  const since = new Date(now.getTime() - HAS_ORDER_DAYS * 24 * 60 * 60 * 1000);
  const orders = await db.order.findMany({
    where: { companyId, customerId: { in: customers.map((c) => c.id) }, createdAt: { gte: since } },
    select: { id: true, orderNumber: true, customerId: true, productId: true, items: { select: { productId: true } } },
    orderBy: { createdAt: 'desc' },
  });

  for (const cart of open) {
    const keys = keysOf.get(cart.id) ?? [];
    const people = new Set(customers.filter((c) => keys.includes(c.phone)).map((c) => c.id));
    const hit = orders.find(
      (o) =>
        people.has(o.customerId) &&
        (!cart.productId || o.productId === cart.productId || o.items.some((i) => i.productId === cart.productId))
    );
    if (hit) out.set(cart.id, { id: hit.id, orderNumber: hit.orderNumber });
  }
  return out;
}

/** The company's `abandonedCarts` settings block, or nothing when there is none or it cannot be read. */
async function cartSettings(companyId: string): Promise<Record<string, unknown>> {
  const row = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  try {
    const all = row?.settings ? JSON.parse(row.settings) : {};
    const block = all?.abandonedCarts;
    return block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The company's retention setting, in days (`abandonedCarts.retentionDays`), clamped, or the default. */
export async function cartRetentionDays(companyId: string): Promise<number> {
  return retentionDaysOf((await cartSettings(companyId)).retentionDays);
}

/**
 * «حوّل السلات اللي فيها اسم ورقم لطلبات تلقائيًا» (`abandonedCarts.autoConvert`): ON unless the company turned it off
 * (the owner, 17/11). Read by the landing door's cart upsert and by the job that converts the carts that waited.
 */
export async function cartAutoConvert(companyId: string): Promise<boolean> {
  return autoConvertOf((await cartSettings(companyId)).autoConvert);
}

// ─── The presses ───

export type CartAction =
  | { action: 'status'; status: CartStatus }
  | { action: 'no_answer' }
  | { action: 'note'; text: string }
  | { action: 'follow_up'; at: Date | null }
  | { action: 'assign'; userId: string | null };

export type CartRefusal = { ok: false; status: number; error: string };
export type CartDone = { ok: true; status: string };

const refuse = (status: number, error: string): CartRefusal => ({ ok: false, status, error });

export const CART_ACTION_AR = {
  FORBIDDEN_WORK: 'لا تملك صلاحية العمل على السلات (تسجيل الاتصال أو تغيير حالة التأكيد أو تعديل الطلبات).',
  FORBIDDEN_NOTE: 'لا تملك صلاحية كتابة ملاحظة.',
  FORBIDDEN_ASSIGN: 'لا تملك صلاحية إسناد الطلبات.',
  FORBIDDEN_CONVERT: 'تحويل السلة لطلب يحتاج صلاحية إنشاء الطلبات.',
  CLOSED: 'هالسلة صارت طلب — حالتها ما بتتغير.',
  NOT_HAND: 'هالحالة ما بتنحط باليد.',
  NO_SUCH_USER: 'الموظف مش موجود أو موقوف.',
  NO_SUCH_ORDER: 'الطلب مش موجود بهالمتجر.',
} as const;

/**
 * ONE PRESS ON ONE CART, WITH ITS HISTORY LINE AND — FOR A STATUS OR AN ASSIGNMENT — ITS AUDIT ROW IN THE PERSON'S NAME.
 *
 * «ما رد» is a status AND a count: it adds one attempt every time it is pressed, so a third unanswered call reads «3»
 * without anybody counting. A worked cart nobody held becomes the worker's, so two agents do not ring the same visitor.
 */
export async function actOnCart(
  user: SessionUser,
  companyId: string,
  cart: { id: string; status: string; assignedToId: string | null },
  input: CartAction
): Promise<CartDone | CartRefusal> {
  const powers = cartPowers(user);

  if (input.action === 'note') {
    if (!powers.note) return refuse(403, CART_ACTION_AR.FORBIDDEN_NOTE);
    await db.abandonedCartActivity.create({
      data: { companyId, cartId: cart.id, userId: user.id, action: 'NOTE', note: input.text },
    });
    return { ok: true, status: cart.status };
  }

  if (input.action === 'assign') {
    if (!powers.assign) return refuse(403, CART_ACTION_AR.FORBIDDEN_ASSIGN);
    if (input.userId) {
      const person = await db.user.findFirst({ where: { id: input.userId, companyId, status: 'ACTIVE' }, select: { id: true } });
      if (!person) return refuse(400, CART_ACTION_AR.NO_SUCH_USER);
    }
    await db.abandonedCart.update({
      where: { id: cart.id },
      data: {
        assignedToId: input.userId,
        activities: {
          create: { companyId, userId: user.id, action: 'ASSIGNED', metadata: JSON.stringify({ from: cart.assignedToId, to: input.userId }) },
        },
      },
    });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'ABANDONED_CART_ASSIGNED',
      entity: 'AbandonedCart',
      entityId: cart.id,
      previousData: { assignedToId: cart.assignedToId },
      newData: { assignedToId: input.userId },
    });
    return { ok: true, status: cart.status };
  }

  if (!powers.work) return refuse(403, CART_ACTION_AR.FORBIDDEN_WORK);

  if (input.action === 'follow_up') {
    await db.abandonedCart.update({
      where: { id: cart.id },
      data: {
        nextFollowUpAt: input.at,
        activities: {
          create: { companyId, userId: user.id, action: 'FOLLOW_UP', metadata: JSON.stringify({ at: input.at?.toISOString() ?? null }) },
        },
      },
    });
    return { ok: true, status: cart.status };
  }

  // A status — «ما رد» is the status NO_ANSWER pressed once more.
  const next: CartStatus = input.action === 'no_answer' ? 'NO_ANSWER' : input.status;
  if (isClosedCart(cart.status)) return refuse(409, CART_ACTION_AR.CLOSED);
  if (!HAND_STATUSES.includes(next)) return refuse(400, CART_ACTION_AR.NOT_HAND);
  const takesIt = !cart.assignedToId;
  await db.abandonedCart.update({
    where: { id: cart.id },
    data: {
      status: next,
      ...(next === 'NO_ANSWER' ? { attempts: { increment: 1 } } : {}),
      ...(takesIt ? { assignedToId: user.id } : {}),
      activities: {
        create: {
          companyId,
          userId: user.id,
          action: next === 'NO_ANSWER' ? 'NO_ANSWER' : 'STATUS_CHANGED',
          fromStatus: cart.status,
          toStatus: next,
          ...(takesIt ? { metadata: JSON.stringify({ assignedTo: user.id }) } : {}),
        },
      },
    },
  });
  await logAudit({
    companyId,
    userId: user.id,
    action: 'ABANDONED_CART_STATUS',
    entity: 'AbandonedCart',
    entityId: cart.id,
    previousData: { status: cart.status },
    newData: { status: next },
  });
  return { ok: true, status: next };
}

/**
 * «حوّل لطلب» — THE ORDER IS MADE BY THE ORDER DOOR; THIS ONLY TIES THE CART TO IT.
 *
 * The screen opens the ordinary «طلب سريع جديد» form filled from the cart and posts it to `POST /api/orders` — the same
 * validation, phone rule, blacklist, pricing, reservation-free intake, activity, status log, audit and notice as any
 * order typed by hand. Nothing about the order is decided here, and no figure is computed. When the door answers with
 * the new order, the screen calls this with its id: the order must be this store's, the cart must still be open, and
 * then the cart is CONVERTED and points at it — with a history line and an audit row in the person's name.
 */
export async function convertCart(
  user: SessionUser,
  ctx: { companyId: string; storeId: string },
  cart: { id: string; status: string },
  orderId: string
): Promise<(CartDone & { orderNumber: string }) | CartRefusal> {
  if (!cartPowers(user).convert) return refuse(403, CART_ACTION_AR.FORBIDDEN_CONVERT);
  if (isClosedCart(cart.status)) return refuse(409, CART_ACTION_AR.CLOSED);
  const order = await db.order.findFirst({
    where: { id: orderId, companyId: ctx.companyId, storeId: ctx.storeId },
    select: { id: true, orderNumber: true },
  });
  if (!order) return refuse(404, CART_ACTION_AR.NO_SUCH_ORDER);

  await db.abandonedCart.update({
    where: { id: cart.id },
    data: {
      status: 'CONVERTED',
      orderId: order.id,
      activities: {
        create: {
          companyId: ctx.companyId,
          userId: user.id,
          action: 'CONVERTED',
          fromStatus: cart.status,
          toStatus: 'CONVERTED',
          metadata: JSON.stringify({ orderId: order.id, orderNumber: order.orderNumber }),
        },
      },
    },
  });
  await logAudit({
    companyId: ctx.companyId,
    userId: user.id,
    action: 'ABANDONED_CART_CONVERTED',
    entity: 'AbandonedCart',
    entityId: cart.id,
    previousData: { status: cart.status },
    newData: { status: 'CONVERTED', orderId: order.id, orderNumber: order.orderNumber },
  });
  return { ok: true, status: 'CONVERTED', orderNumber: order.orderNumber };
}
