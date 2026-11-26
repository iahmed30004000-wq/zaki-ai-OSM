import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { count } from '../numeric-input';
import { activeBlock } from '../blacklist';
import { computeCod, roundMinor } from '../money';
import { priceIncludesDeliveryFor } from '../delivery-fees';
import { unitCostsOf } from '../product-fixed-cost';
import { resolveRegionId } from '../regions';
import { normalizePhoneNumber } from '../phone';
import { isValidPhoneFor, phoneErrorFor, phoneKeys } from '../phone-rules';
import { realStoresOnly } from '../test-store';
import { isValidTransition, type ConfirmationStatus } from '../confirmation-workflow';
import { endOrder, type EndOutcome } from '../order-cancel';
import { EDITABLE_NOW, ENDED, orderEditable } from '../order-editable';
import { logAudit } from '../audit';
import { notify } from '../notify';
import { V1_CODE, V1Fault } from './door';
import type { SystemCaller } from './system-token';
import { decimalString, offersDiscount, priceLines } from './order-intake';
import { bookkeepingActor, recordAttempt, resolvesFollowUp } from './landing-chat';

/**
 * THE REPLIES SYSTEM EDITS AND ENDS AN ORDER IT TOOK — `POST /api/v1/orders/{id}/amend|cancel`.
 *
 * A customer changes the number, the address or the quantity in the chat, or changes their mind. Until now that reached the
 * confirmation desk as a note and a person did the edit; here it is done, by the same rules a person's edit and the landing
 * chat's edit follow — and in the same place a person would look afterwards: the order's history.
 *
 * ── WHOSE ORDER, AND UNTIL WHEN ──
 *
 * A system edits only an order it CREATED: `order.source` is the token's `caller.system` (`createSystemOrder` writes it), and
 * anything else — another system's order, another company's, an order a person typed — is a 404, never a 403: a 403 would say the
 * id exists. And only while `orderEditable` says so (`order-editable.ts`, the landing chat's own question): not confirmed, not
 * ended, not on a shipment. After that it is the confirmation desk's order and the answer is 409 `NOT_EDITABLE`. The write itself
 * carries the same condition (`EDITABLE_NOW`) and the row's version, so an order confirmed a moment after it was read is refused
 * by the database, not edited.
 *
 * ── NOTHING DECIDED HERE THAT IS DECIDED ELSEWHERE ──
 *
 * The phone is checked against the store's country (`isValidPhoneFor`) and the company's blacklist (`activeBlock`), as at the order
 * door. A change of lines is priced by `priceLines` and `computeCod` — the very ones `createSystemOrder` prices a new order with,
 * from this company's catalogue and by nothing the caller sent; a bundle is honoured only on an exact quantity. The customer row is
 * written the way the staff screen's PATCH writes it (name, phone, address, city in place), with its refusal of a number another
 * customer of the store already has. A cancel is `endOrder`, as the landing chat's cancel is: REJECTED, «غيّر رأيه».
 *
 * ── WHAT A CHANGE DOES NOT TOUCH ──
 *
 * An order a person has priced (a discount, a delivery fee) or whose goods the warehouse has begun to hold (reserved, delivered,
 * returned) keeps its lines: re-pricing it from the catalogue would overwrite what that person did, so a change of lines is 409
 * `NOT_EDITABLE` with the reason, and the customer's data and notes may still change. Delivery fee and discount are never the
 * caller's to set here either.
 *
 * ── AND THE DESK SEES IT ──
 *
 * One `OrderActivity` — «تعديل من المحادثة» — carries the difference in words (`diff`), the system's reason, and the new total; the
 * supervisors and the order's holders are told. No customer detail is sent anywhere else, and none to a model.
 */

/** The history lines this door writes. Their words are `order-timeline.ts`'s. */
export const AMEND_ACTION = 'EDITED_FROM_CHAT';
export const CANCEL_ACTION = 'CANCELLED_FROM_CHAT';

/** The structured reason the agent picks when the customer changes their mind before the yes (as the landing chat's cancel). */
const CHANGED_MIND = 'CUSTOMER_CHANGED_MIND';

/** Who the history says did it, in words. */
const systemAr = (system: string) => (system === 'replies' ? 'نظام الردود' : system);

/**
 * THE BODY — every field optional, the present ones replace and the absent ones stay.
 *
 * `totals.subtotal` is read for one purpose, as at the order door: to answer whether our catalogue agreed with what the customer was
 * quoted (`price_adjusted`). It is never written. There is no `delivery_fee` and no discount: the OMS prices.
 */
export const v1AmendSchema = z.object({
  customer: z
    .object({
      name: z.string().trim().min(2).max(80).optional(),
      phone: z.string().trim().min(7).max(20).optional(),
      city: z.string().trim().max(60).optional(),
      address: z.string().trim().max(200).optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        product_code: z.string().trim().min(1).max(64),
        quantity: count(999, 1),
      })
    )
    .min(1)
    .max(20)
    .optional(),
  totals: z.object({ subtotal: decimalString.optional().nullable() }).optional().nullable(),
  notes: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(500).optional().nullable(),
});

export type V1AmendInput = z.infer<typeof v1AmendSchema>;

export const v1CancelSchema = z.object({ reason: z.string().trim().max(500).optional().nullable() });

/** Does the body ask for anything at all? `reason` alone is a comment, not a change. */
export function asksForAChange(c: V1AmendInput): boolean {
  const k = c.customer;
  return !!(k?.name || k?.phone || k?.city || k?.address || c.items || c.notes);
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  version: true,
  source: true,
  confirmationStatus: true,
  shippingStatus: true,
  shippingBatchId: true,
  trackingNumber: true,
  labelPrintedAt: true,
  countryId: true,
  storeId: true,
  regionId: true,
  customerId: true,
  productId: true,
  offerId: true,
  sellingPrice: true,
  shippingCost: true,
  discountAmount: true,
  deliveryFee: true,
  totalAmount: true,
  currency: true,
  deliveryAddress: true,
  customerNotes: true,
  moderatorId: true,
  assignedToId: true,
  currentOwnerId: true,
  nextFollowUpAt: true,
  followUpStatus: true,
  customer: { select: { id: true, fullName: true, phone: true, rawPhone: true, address: true, city: true } },
  store: { select: { id: true, country: { select: { id: true, code: true, currencyCode: true, minorUnit: true } } } },
  items: {
    select: {
      id: true,
      productName: true,
      quantity: true,
      freeQuantity: true,
      discountShare: true,
      reservedQty: true,
      deliveredQty: true,
      returnedQty: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

export type OwnOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

/**
 * THE ORDER THIS SYSTEM CREATED, OF THIS COMPANY — or a 404.
 *
 * The company is the token's and the source is the token's system, both in the WHERE: an id that is another company's, another
 * system's or a person's answers exactly as an id that does not exist.
 */
export async function loadOwnOrder(caller: SystemCaller, orderId: string): Promise<OwnOrder> {
  const order = await db.order.findFirst({
    where: { id: orderId, companyId: caller.companyId, source: caller.system },
    select: ORDER_SELECT,
  });
  if (!order) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');
  return order;
}

/**
 * THE SAME ORDER, FOR A CALLER THAT PROVED THE CUSTOMER ANOTHER WAY — the WhatsApp order bot, which only reaches the orders
 * of the number that wrote to it (`whatsapp/bot/order-door.ts`). The company is still in the WHERE; the source is not,
 * because the customer's order may have come from any door.
 */
export async function loadCompanyOrder(companyId: string, orderId: string): Promise<OwnOrder> {
  const order = await db.order.findFirst({ where: { id: orderId, companyId }, select: ORDER_SELECT });
  if (!order) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');
  return order;
}

/**
 * Who the history line names, when it is not the calling system's own door: the WhatsApp order bot writes its own
 * action and its own name, so the desk never reads «نظام الردود» for a change the bot made.
 */
export interface AmendActor {
  action?: string;
  whoAr?: string;
  via?: string;
  auditAction?: string;
}

export interface AmendResult {
  orderId: string;
  orderNumber: string;
  status: string;
  priceAdjusted: boolean;
  totals: { subtotal: number; discount: number; deliveryFee: number; total: number };
  currency: string;
  minorUnit: number;
}

const notEditable = (message: string, reason?: string) =>
  new V1Fault(409, V1_CODE.NOT_EDITABLE, message, reason ? { reason } : null);

/** What this order's own columns say it is worth — read, never recomputed (an add-on the customer accepted stays in `totalAmount`). */
function storedTotals(o: OwnOrder) {
  return {
    subtotal: Number(o.sellingPrice),
    discount: o.items.reduce((sum, l) => sum + Number(l.discountShare), 0),
    deliveryFee: Number(o.shippingCost),
    total: Number(o.totalAmount),
  };
}

const lineWords = (l: { name: string; quantity: number; free?: number }) =>
  `${l.name} ×${l.quantity}${l.free ? ` (+${l.free} مجاني)` : ''}`;

/**
 * AMEND. Reads the order, checks every rule that can refuse, then writes once, in one transaction, under the order's version.
 */
export async function amendSystemOrder(caller: SystemCaller, o: OwnOrder, change: V1AmendInput, as: AmendActor = {}): Promise<AmendResult> {
  const { companyId } = caller;
  const who = as.whoAr ?? systemAr(caller.system);
  const country = o.store?.country;
  if (!orderEditable(o)) throw notEditable('This order can no longer be edited from here — the confirmation desk has it');
  if (!o.store || !country) throw notEditable('This order is not placed in a store');
  const minorUnit = country.minorUnit;

  const orderData: Prisma.OrderUncheckedUpdateManyInput = {};
  const custData: Prisma.CustomerUncheckedUpdateInput = {};
  const diff: string[] = [];
  const changes: Record<string, unknown> = {};

  // ─── The customer ───
  const k = change.customer;
  if (k?.name && k.name !== o.customer.fullName) {
    custData.fullName = k.name;
    diff.push(`اسم الزبون: ${o.customer.fullName} ← ${k.name}`);
    changes.name = { from: o.customer.fullName, to: k.name };
  }

  if (k?.phone) {
    // The format against THIS store's country first — as the order door asks it — then a number that is new to the order.
    if (!isValidPhoneFor(country.code, k.phone)) {
      throw new V1Fault(422, V1_CODE.INVALID_PHONE, phoneErrorFor(country.code), { field: 'customer.phone' });
    }
    const normalized = normalizePhoneNumber(k.phone, country.code);
    // The same number stored in the older form (a foreign number before it kept its code) is the same number.
    if (normalized !== o.customer.phone && !phoneKeys(normalized).includes(o.customer.phone)) {
      // The raw phone as sent, which is what `activeBlock` canonicalises (normalising first would drop the `+` that marks a foreign form).
      if (await activeBlock(db, companyId, k.phone)) {
        throw new V1Fault(422, V1_CODE.CUSTOMER_BLACKLISTED, 'This phone may not place an order');
      }
      // A number another customer of this store already holds is refused, as the staff screen refuses it.
      const taken = await db.customer.findFirst({
        where: { companyId, storeId: o.store.id, phone: { in: phoneKeys(normalized) }, id: { not: o.customerId } },
        select: { id: true },
      });
      if (taken) throw new V1Fault(409, V1_CODE.DUPLICATE_PHONE, 'This phone belongs to another customer', { field: 'customer.phone' });
      custData.phone = normalized;
      custData.rawPhone = k.phone;
      diff.push(`رقم الهاتف: ${o.customer.rawPhone || o.customer.phone} ← ${k.phone}`);
      changes.phone = { from: o.customer.rawPhone || o.customer.phone, to: k.phone };
    }
  }

  if (k?.city) {
    // The governorate the delivery fee table is keyed on, found as every intake door finds it. One that matches none is stored as
    // none (the desk asks for it before the yes), never kept as the old one: the customer said somewhere else.
    const regionId = await resolveRegionId(db, country.id, k.city);
    if (k.city !== o.customer.city || regionId !== o.regionId) {
      custData.city = k.city;
      orderData.regionId = regionId;
      diff.push(`المدينة: ${o.customer.city || '—'} ← ${k.city}${regionId ? '' : ' (غير معروفة — حدّد المحافظة عند التأكيد)'}`);
      changes.city = { from: o.customer.city, to: k.city, regionMatched: regionId !== null };
    }
  }

  if (k?.address) {
    const was = o.deliveryAddress ?? o.customer.address;
    if (k.address !== was) {
      // The parcel's own address, and the customer keeps the latest street — as the landing chat's address change writes both.
      orderData.deliveryAddress = k.address;
      custData.address = k.address;
      diff.push(`العنوان: ${was || '—'} ← ${k.address}`);
      changes.address = { from: was, to: k.address };
    }
  }

  if (change.notes !== undefined && change.notes !== (o.customerNotes ?? '')) {
    orderData.customerNotes = change.notes || null;
    diff.push(`ملاحظات الزبون: ${o.customerNotes || '—'} ← ${change.notes || '—'}`);
    changes.notes = { from: o.customerNotes, to: change.notes || null };
  }

  // ─── The lines, repriced from the catalogue ───
  let priced: {
    lines: Awaited<ReturnType<typeof priceLines>>;
    cod: ReturnType<typeof computeCod>;
    priceIncludesDelivery: boolean;
    costOfGoods: number;
  } | null = null;
  let priceAdjusted = false;

  if (change.items) {
    // What a person priced, or the warehouse began to hold, is not rewritten from the catalogue (see the header).
    const staffPriced = Number(o.discountAmount) !== 0 || Number(o.shippingCost) !== 0 || o.deliveryFee !== null;
    const held = o.items.some((l) => l.reservedQty > 0 || l.deliveredQty !== null || (l.returnedQty ?? 0) > 0);
    if (staffPriced || held) {
      throw notEditable('The lines of this order were priced or held by the team — only the customer data can change from here', 'LINES_LOCKED');
    }

    const codes = [...new Set(change.items.map((i) => i.product_code))];
    // Of this order's own store: a code from another shop is simply not found, as at the order door.
    const rows = await db.product.findMany({
      where: { companyId, storeId: o.store.id, sku: { in: codes }, status: 'ACTIVE', ...realStoresOnly() },
      select: { id: true, name: true, image: true, basePrice: true, sku: true },
    });
    const missing = codes.filter((c) => !rows.some((r) => r.sku === c));
    if (missing.length > 0) {
      throw new V1Fault(422, V1_CODE.PRODUCT_UNKNOWN, 'One or more product_code values are not on sale', { product_codes: missing });
    }

    const bySku = new Map(rows.map((r) => [r.sku, { id: r.id, name: r.name, image: r.image, basePrice: r.basePrice }]));
    const lines = await priceLines(
      companyId,
      minorUnit,
      bySku,
      change.items.map((i) => ({ code: i.product_code, quantity: i.quantity }))
    );
    const addOns = await db.orderAddOn.findMany({ where: { orderId: o.id }, select: { quantity: true, price: true } });
    const priceIncludesDelivery = await priceIncludesDeliveryFor(o.store.id, lines.some((l) => l.offer?.deliveryIncluded === true) ? true : undefined);
    const cod = computeCod({
      lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, freeQuantity: l.freeQuantity })),
      discount: offersDiscount(lines),
      addOns: addOns.map((a) => ({ quantity: a.quantity, unitPrice: Number(a.price) })),
      // The fee is not the caller's to set and not this door's to guess — the order door's own rule: the courier's figure comes at shipment.
      deliveryFee: 0,
      priceIncludesDelivery,
      minorUnit,
    });
    const costByProduct = await unitCostsOf(db, companyId, [...new Set(lines.map((l) => l.productId))]);
    const costOfGoods = roundMinor(
      lines.reduce((sum, l) => sum + (costByProduct.get(l.productId) ?? 0) * (l.quantity + l.freeQuantity), 0),
      minorUnit
    );

    const before = o.items.map((l) => lineWords({ name: l.productName, quantity: l.quantity, free: l.freeQuantity }));
    const after = lines.map((l) => lineWords({ name: l.productName, quantity: l.quantity, free: l.freeQuantity }));
    const was = Number(o.totalAmount);
    if (JSON.stringify(before) !== JSON.stringify(after) || cod.cod !== was) {
      priced = { lines, cod, priceIncludesDelivery, costOfGoods };
      diff.push(`البنود: ${before.join(' + ')} ← ${after.join(' + ')}`);
      diff.push(`المجموع: ${was} ← ${cod.cod}`);
      changes.items = { from: before, to: after };
      changes.total = { from: was, to: cod.cod };
    }

    const quoted = change.totals?.subtotal ? Number(change.totals.subtotal) : null;
    priceAdjusted = quoted !== null && roundMinor(quoted, minorUnit) !== cod.subtotal;
  }

  const totals = priced
    ? { subtotal: priced.cod.subtotal, discount: priced.cod.discount, deliveryFee: 0, total: priced.cod.cod }
    : storedTotals(o);
  const answer: AmendResult = {
    orderId: o.id,
    orderNumber: o.orderNumber,
    status: o.confirmationStatus,
    priceAdjusted,
    totals,
    currency: o.currency,
    minorUnit,
  };

  // Nothing the order does not already say: nothing is written and nobody is told.
  if (diff.length === 0) return answer;

  if (priced) {
    const head = priced.lines[0];
    orderData.productId = head.productId;
    orderData.offerId = head.offer?.id ?? null;
    orderData.quantity = priced.lines.reduce((n, l) => n + l.quantity, 0);
    orderData.freeQuantity = head.freeQuantity;
    orderData.sellingPrice = priced.cod.subtotal;
    orderData.totalAmount = priced.cod.cod;
    orderData.shippingCost = 0;
    orderData.priceIncludesDelivery = priced.priceIncludesDelivery;
    orderData.estimatedCostOfGoods = priced.costOfGoods;
    orderData.productNameSnapshot = head.productName;
    orderData.productImageSnapshot = head.productImage;
  }

  await db.$transaction(async (tx) => {
    // The version and the editable condition are the write's own: an order confirmed or shipped since it was read is refused here.
    const res = await tx.order.updateMany({
      where: { id: o.id, companyId, version: o.version, ...EDITABLE_NOW },
      data: { ...orderData, version: { increment: 1 } },
    });
    if (res.count !== 1) throw notEditable('The order changed while it was being edited — read it again', 'ORDER_MOVED_ON');

    if (priced) {
      await tx.orderItem.deleteMany({ where: { orderId: o.id } });
      await tx.orderItem.createMany({
        data: priced.lines.map((l, i) => ({
          companyId,
          orderId: o.id,
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
          freeQuantity: l.freeQuantity,
          unitPrice: l.unitPrice,
          discountShare: priced.cod.discountShares[i] ?? 0,
          lineTotal: priced.cod.lineTotals[i] ?? 0,
          // The customer's own lines, as intake wrote them: re-writing them must not make anybody a cross-seller.
          addedStage: 'INTAKE',
        })),
      });
    }
    if (Object.keys(custData).length > 0) {
      await tx.customer.update({ where: { id: o.customerId }, data: custData });
    }
    await tx.orderActivity.create({
      data: {
        companyId,
        orderId: o.id,
        // No employee did this: the words carry the system, as the creation line does.
        userId: null,
        action: as.action ?? AMEND_ACTION,
        metadata: JSON.stringify({
          source: who,
          via: as.via ?? 'api/v1',
          system: caller.system,
          diff,
          amendReason: change.reason?.trim() || null,
          ...(priced ? { total: priced.cod.cod } : {}),
          changes,
        }),
      },
    });
  });

  await logAudit({
    companyId,
    userId: null,
    action: as.auditAction ?? 'ORDER_AMENDED_API_V1',
    entity: 'Order',
    entityId: o.id,
    // Which fields moved, never what they held: the history line has the words.
    newData: { system: caller.system, tokenId: caller.tokenId, orderNumber: o.orderNumber, fields: Object.keys(changes) },
  });
  notify({
    companyId,
    storeId: o.storeId,
    audience: { permission: 'confirmation.supervise', userIds: [o.moderatorId, o.assignedToId, o.currentOwnerId] },
    actorId: null,
    title: 'تعديل طلب من المحادثة',
    message: `عدّل ${who} الطلب #${o.orderNumber} بطلب من الزبون — التفاصيل في سجلّ الطلب.`,
    type: 'SYSTEM_ALERT',
    link: `/orders?highlight=${o.id}`,
    orderId: o.id,
  });

  return answer;
}

export interface CancelResult {
  orderId: string;
  orderNumber: string;
  status: string;
  already: boolean;
}

class EndRefused extends Error {
  constructor(readonly outcome: Extract<EndOutcome, { ok: false }>) {
    super(outcome.code);
  }
}

/**
 * CANCEL — `endOrder`, the one helper every door that ends an order goes through, ending it as the confirmation desk's «رفض» does.
 *
 * Already ended is a 200 `already: true` (a retry with a new key, or the desk got there first): nothing is written twice. Confirmed
 * or on a shipment is 409 `NOT_EDITABLE` — a person's call from there, as the landing chat's cancel answers.
 */
export async function cancelSystemOrder(
  caller: SystemCaller,
  o: OwnOrder,
  reason: string | null | undefined,
  now: Date = new Date()
): Promise<CancelResult> {
  const { companyId } = caller;
  const from = o.confirmationStatus;
  if (ENDED.includes(from)) return { orderId: o.id, orderNumber: o.orderNumber, status: from, already: true };
  if (!orderEditable(o) || !isValidTransition(from as ConfirmationStatus, 'REJECTED')) {
    throw notEditable('This order can no longer be cancelled from here — the confirmation desk has it');
  }

  const actor = await bookkeepingActor(companyId);
  const by = `${systemAr(caller.system)} (المحادثة)`;
  const said = reason?.trim() || 'الزبون تراجع عن الطلب قبل التأكيد';
  const words = `${by}: ${said}`.slice(0, 2000);

  let ended: Extract<EndOutcome, { ok: true }>;
  try {
    ended = await db.$transaction(async (tx) => {
      await recordAttempt(tx, { companyId, orderId: o.id, actor, result: 'REJECTED', note: words });
      const outcome = await endOrder({
        orderId: o.id,
        companyId,
        storeId: null,
        by: { id: actor.id, name: by, role: actor.role },
        door: 'CONFIRMATION',
        kind: 'CANCEL',
        endAs: 'REJECTED',
        reason: CHANGED_MIND,
        rejectionNote: reason?.trim() || null,
        data: resolvesFollowUp(o, now),
        logNote: words,
        noteBody: null,
        expectedVersion: o.version,
        tx,
      });
      if (!outcome.ok) throw new EndRefused(outcome);
      await tx.orderActivity.create({
        data: {
          companyId,
          orderId: o.id,
          userId: null,
          action: CANCEL_ACTION,
          metadata: JSON.stringify({ source: systemAr(caller.system), via: 'api/v1', system: caller.system, notes: said }),
        },
      });
      return outcome;
    });
  } catch (e) {
    if (e instanceof EndRefused) {
      // Ended by somebody else between the read and the write is the same «already»; every other refusal is the desk's.
      if (e.outcome.code === 'ALREADY_ENDED') return { orderId: o.id, orderNumber: o.orderNumber, status: 'REJECTED', already: true };
      throw notEditable(e.outcome.error, e.outcome.code);
    }
    throw e;
  }
  // Committed: only now is anybody told (a REJECTED end announces nothing to the apps, as at the desk's door).
  await ended.afterCommit();

  await logAudit({
    companyId,
    userId: null,
    action: 'ORDER_REJECTED',
    entity: 'Order',
    entityId: o.id,
    previousData: { confirmationStatus: from, nextFollowUpAt: o.nextFollowUpAt },
    newData: { confirmationStatus: 'REJECTED', rejectionReason: CHANGED_MIND, action: 'reject', by, system: caller.system, tokenId: caller.tokenId },
  });
  notify({
    companyId,
    storeId: o.storeId,
    audience: { permission: 'confirmation.supervise', userIds: [o.moderatorId, o.assignedToId, o.currentOwnerId] },
    actorId: null,
    title: 'رفض طلب',
    message: `الطلب #${o.orderNumber} أصبح بالحالة REJECTED بواسطة ${by}.`,
    type: 'SYSTEM_ALERT',
    link: `/orders?highlight=${o.id}`,
    orderId: o.id,
  });

  return { orderId: o.id, orderNumber: o.orderNumber, status: 'REJECTED', already: false };
}
