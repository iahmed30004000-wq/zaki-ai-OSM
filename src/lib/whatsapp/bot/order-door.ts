/**
 * THE WHATSAPP ORDER BOT, AT THE ORDER SYSTEM — the real door of `door.ts`.
 *
 * This file changes orders and never talks to a model. The model only PROPOSES (a tool call); `tools.ts` decides in code
 * whether the proposal stands (a confirmation needs the customer's own clear yes, read by `words.ts`), and only then is
 * one of the functions below called. The owner's decision of 2026-11-26 sets what the bot may do, and nothing more:
 *
 *   read the customer's orders · change the name, the address, the city and the notes · swap the offer for another live
 *   catalogue offer of the same product while the order is still NEW · confirm after the customer's clear yes.
 *   No cancel, no price, no discount, no new order.
 *
 * ── WHOSE ORDERS ──
 *
 * Only the orders of the number that wrote: the conversation's linked customer, and every customer of the company whose
 * stored phone is one of the forms of the WhatsApp number (`phoneKeysAnyStore`). An order number outside that set is
 * «not found», exactly like one that does not exist.
 *
 * ── THE SAME DECISIONS A PERSON MAKES, BY THE SAME HELPERS ──
 *
 * A confirmation takes the landing confirmation chat's steps (`v1/landing-chat.ts`), which are the agent's own: the
 * transition table, «no governorate, no yes», no choice per piece no yes, the confirmed-twin guard under its lock, the
 * version-guarded write, `reserveOrderLines` in the same transaction, the status log, then `order.confirmed`, the
 * conversions and the supervisors' notice after the commit. The customer's details go through `amendSystemOrder`
 * (`v1/order-amend.ts`, the replies system's edit: phone, blacklist and editable checks, one transaction under the
 * version). The offer through `rewriteLandingOffer` (`v1/landing-door.ts`, the catalogue's price and the door's own
 * figures). Every line on the order's history says «مساعد واتساب الآلي»; the two tables that must name a user carry the
 * company's administrator as the bookkeeping actor (`bookkeepingActor`), as the landing chat does.
 */
import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { phoneKeysAnyStore } from '../../phone-rules';
import { matchRegion } from '../../regions';
import { isValidTransition, type ConfirmationStatus } from '../../confirmation-workflow';
import { needsRegionFirst } from '../../confirmation-queue';
import { TwinConfirmedRefusal, guardConfirmAgainstTwins } from '../../confirmed-twin';
import { reserveOrderLines } from '../../reservation';
import { ENDED, orderEditable } from '../../order-editable';
import { emitAppEvent } from '../../apps/events';
import { queueConversions } from '../../conversions/emit';
import { logAudit } from '../../audit';
import { notify } from '../../notify';
import { parseVariantOptions } from '../../product-variants';
import { landingOrderFigures, lineUntouched, readLandingProduct, rewriteLandingOffer } from '../../v1/landing-door';
import { bookkeepingActor, recordAttempt, resolvesFollowUp } from '../../v1/landing-chat';
import { amendSystemOrder, loadCompanyOrder, v1AmendSchema } from '../../v1/order-amend';
import { V1Fault } from '../../v1/door';
import type { BotDoor, BotOrderView, BotProductInfo, CustomerChange, DoorAnswer } from './door';
import type { ProductNote } from './settings';

/** The name every history line, audit row and notice carries. */
export const BOT_ACTOR_AR = 'مساعد واتساب الآلي';

/** The history lines the bot writes. Their words are `order-timeline.ts`'s. */
export const BOT_ACTION = {
  CONFIRMED: 'WHATSAPP_BOT_CONFIRMED',
  EDITED: 'WHATSAPP_BOT_EDITED',
  OFFER: 'WHATSAPP_BOT_OFFER_CHANGED',
} as const;

/** How far back the bot looks for the customer's orders. */
const ORDERS_SHOWN = 10;

const BOT_SELECT = {
  id: true,
  orderNumber: true,
  version: true,
  createdAt: true,
  confirmationStatus: true,
  shippingStatus: true,
  shippingBatchId: true,
  trackingNumber: true,
  labelPrintedAt: true,
  currency: true,
  totalAmount: true,
  discountAmount: true,
  shippingCost: true,
  deliveryFee: true,
  priceIncludesDelivery: true,
  productId: true,
  offerId: true,
  storeId: true,
  countryId: true,
  customerId: true,
  replacesOrderId: true,
  regionId: true,
  confirmedAt: true,
  nextFollowUpAt: true,
  followUpStatus: true,
  moderatorId: true,
  deliveryAddress: true,
  customerNotes: true,
  productNameSnapshot: true,
  region: { select: { name: true } },
  store: { select: { countryId: true } },
  offer: { select: { id: true, name: true } },
  product: { select: { id: true, name: true, variantOptions: true } },
  customer: { select: { fullName: true, address: true, city: true } },
  items: {
    select: { id: true, productId: true, productName: true, quantity: true, freeQuantity: true, reservedQty: true, deliveredQty: true, variantSummary: true },
    orderBy: { createdAt: 'asc' },
  },
} as const;
type BotRow = Prisma.OrderGetPayload<{ select: typeof BOT_SELECT }>;

/** Who the bot is talking to: the conversation's company, its linked customer and its WhatsApp number. */
export interface BotCustomer {
  companyId: string;
  customerId: string | null;
  waId: string;
}

/** Every order of this number, as a WHERE. */
export function customerOrdersWhere(c: BotCustomer): Prisma.OrderWhereInput {
  const keys = phoneKeysAnyStore(`+${c.waId}`);
  const or: Prisma.OrderWhereInput[] = [];
  if (c.customerId) or.push({ customerId: c.customerId });
  if (keys.length) or.push({ customer: { phone: { in: keys } } });
  // No customer and no key: nothing (an id that matches nothing, never «every order of the company»).
  return { companyId: c.companyId, OR: or.length ? or : [{ id: '__none__' }] };
}

/** Only an untouched single line of a product without per-piece choices may move to another offer, and only while NEW. */
function offerMovable(o: BotRow): boolean {
  // `lineUntouched` reads the line and the money columns, all of which BOT_SELECT carries.
  const line = o as unknown as Parameters<typeof lineUntouched>[0];
  return o.confirmationStatus === 'NEW' && orderEditable(o) && lineUntouched(line) && parseVariantOptions(o.product?.variantOptions).length === 0;
}

async function viewOf(companyId: string, o: BotRow, full: boolean): Promise<BotOrderView> {
  const figures = await landingOrderFigures(companyId, {
    productId: o.productId,
    offerId: o.offerId,
    regionName: o.region?.name ?? null,
    totalAmount: Number(o.totalAmount),
    priceIncludesDelivery: o.priceIncludesDelivery,
  });
  let cities: string[] | undefined;
  if (full) {
    const countryId = o.countryId ?? o.store?.countryId ?? null;
    cities = countryId
      ? (await db.region.findMany({ where: { countryId, isActive: true }, select: { name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((r) => r.name)
      : [];
  }
  return {
    orderNumber: o.orderNumber,
    createdAt: o.createdAt.toISOString(),
    status: o.confirmationStatus,
    shippingStatus: o.shippingStatus,
    editable: orderEditable(o),
    offerChangeAllowed: offerMovable(o),
    product: o.product ? { id: o.product.id, name: o.product.name } : null,
    offer: o.offer ? { id: o.offer.id, name: o.offer.name } : null,
    items: o.items.map((i) => ({ name: i.productName, quantity: i.quantity, freeQuantity: i.freeQuantity })),
    currency: o.currency,
    total: Number(o.totalAmount),
    cod: figures.cod,
    deliveryFee: figures.deliveryFee,
    deliveryIncluded: figures.deliveryIncluded,
    feeKnown: figures.feeKnown,
    feeExact: figures.feeExact,
    customer: {
      name: o.customer.fullName,
      city: o.region?.name ?? o.customer.city ?? null,
      address: o.deliveryAddress ?? o.customer.address ?? null,
      notes: o.customerNotes ?? '',
    },
    ...(full ? { offers: figures.offers, cities, hasVariants: parseVariantOptions(o.product?.variantOptions).length > 0 } : {}),
  };
}

const refuse = (error: string): DoorAnswer => ({ ok: false, error });

/** A V1 refusal in words the model can act on. */
function faultWords(e: unknown): string | null {
  if (!(e instanceof V1Fault)) return null;
  if (e.details?.reason === 'ORDER_MOVED_ON') return 'The order changed while it was being edited. Read it again with get_order_details and retry once.';
  if (e.status === 409) return 'The order can no longer be changed from the chat (the team has it). Tell the customer a colleague will handle it and offer transfer_to_human.';
  if (e.status === 422) return `The order system refused the value: ${e.message}. Ask the customer for a correct value.`;
  return `The order system refused: ${e.message}`;
}

export function realDoor(customer: BotCustomer, productNotes: ProductNote[] = []): BotDoor {
  const { companyId } = customer;
  const mine = customerOrdersWhere(customer);

  const find = (orderNumber: string) =>
    db.order.findFirst({ where: { AND: [mine, { orderNumber: orderNumber.trim().replace(/^#/, '') }] }, select: BOT_SELECT });
  const fresh = async (id: string) => {
    const o = await db.order.findFirst({ where: { id, companyId }, select: BOT_SELECT });
    return o ? viewOf(companyId, o, true) : null;
  };

  return {
    async orders() {
      const rows = await db.order.findMany({ where: mine, orderBy: { createdAt: 'desc' }, take: ORDERS_SHOWN, select: BOT_SELECT });
      const out: BotOrderView[] = [];
      for (const r of rows) out.push(await viewOf(companyId, r, false));
      return out;
    },

    async order(orderNumber) {
      const o = await find(orderNumber);
      return o ? viewOf(companyId, o, true) : null;
    },

    async product(orderNumber): Promise<BotProductInfo | null> {
      const o = await find(orderNumber);
      if (!o) return null;
      const notes = productNotes.find((n) => n.productId === o.productId)?.notes ?? null;
      try {
        const p = await readLandingProduct(companyId, o.productId);
        return {
          name: p.name,
          description: p.description,
          currency: p.currency,
          offers: p.offers.map((f) => ({ id: f.id, name: f.name, quantity: f.quantity, freeQuantity: f.freeQuantity, price: f.price, deliveryIncluded: f.deliveryIncluded })),
          fromStoreOwner: notes,
        };
      } catch {
        return { name: o.product?.name ?? o.productNameSnapshot ?? '', description: '', currency: o.currency, offers: [], fromStoreOwner: notes };
      }
    },

    async amend(orderNumber, change: CustomerChange) {
      const o = await find(orderNumber);
      if (!o) return refuse('No such order for this customer. Use only order numbers from get_customer_orders.');
      if (!orderEditable(o)) return refuse('This order is confirmed, ended or on its way: the bot cannot change it. Offer transfer_to_human.');
      // A city the courier's fee table knows, by the matcher every intake door uses — the landing chat's own rule.
      let city: string | undefined;
      if (change.city !== undefined) {
        const countryId = o.countryId ?? o.store?.countryId ?? null;
        const regions = countryId ? await db.region.findMany({ where: { countryId, isActive: true }, select: { id: true, name: true } }) : [];
        const region = matchRegion(regions, change.city.trim());
        if (!region) return refuse('That city is not in the list of delivery cities. Ask the customer to pick one of the "cities" list of get_order_details.');
        city = region.name;
      }
      const parsed = v1AmendSchema.safeParse({
        customer: {
          ...(change.name ? { name: change.name } : {}),
          ...(city ? { city } : {}),
          ...(change.address ? { address: change.address } : {}),
        },
        ...(change.notes !== undefined ? { notes: change.notes } : {}),
        reason: 'الزبون طلب التعديل في محادثة واتساب',
      });
      if (!parsed.success) return refuse(`Invalid value: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      try {
        const own = await loadCompanyOrder(companyId, o.id);
        await amendSystemOrder(
          { companyId, system: 'whatsapp-bot', tokenId: 'whatsapp-bot', scopes: [] } as never,
          own,
          parsed.data,
          { action: BOT_ACTION.EDITED, whoAr: BOT_ACTOR_AR, via: 'whatsapp', auditAction: BOT_ACTION.EDITED }
        );
      } catch (e) {
        const words = faultWords(e);
        if (words) return refuse(words);
        throw e;
      }
      const order = await fresh(o.id);
      return order ? { ok: true, order } : refuse('The order could not be read again.');
    },

    async changeOffer(orderNumber, offerId) {
      const o = await find(orderNumber);
      if (!o) return refuse('No such order for this customer. Use only order numbers from get_customer_orders.');
      if (o.offerId === offerId) return { ok: true, order: (await fresh(o.id))!, already: true };
      if (!offerMovable(o)) {
        return refuse('The offer of this order can no longer be changed from the chat (only a NEW order, untouched by the team, of a product without sizes/colours). Offer transfer_to_human.');
      }
      const result = await rewriteLandingOffer(companyId, o.id, offerId, {
        blocked: async (row) => (row.confirmationStatus === 'NEW' && orderEditable(row) && lineUntouched(row) ? null : 'NOT_EDITABLE'),
        pick: (offers, _current, id) => offers.find((f) => f.id === id) ?? null,
        action: BOT_ACTION.OFFER,
        by: BOT_ACTOR_AR,
        source: BOT_ACTOR_AR,
      });
      if (!result.ok) {
        if (result.reason === 'OFFER_GONE') return refuse('That offer is not a live offer of this product. Use an id of the "offers" list of get_order_details.');
        if (result.reason === 'ALREADY_ADDED') return refuse('The order changed while it was being edited. Read it again and retry once.');
        return refuse('The offer of this order can no longer be changed from the chat. Offer transfer_to_human.');
      }
      await logAudit({
        companyId,
        userId: null,
        action: BOT_ACTION.OFFER,
        entity: 'Order',
        entityId: o.id,
        previousData: { offerId: o.offerId, total: Number(o.totalAmount) },
        newData: { offerId: result.offer.id, total: result.total, by: BOT_ACTOR_AR },
      });
      const order = await fresh(o.id);
      return order ? { ok: true, order } : refuse('The order could not be read again.');
    },

    async confirm(orderNumber) {
      const o = await find(orderNumber);
      if (!o) return refuse('No such order for this customer. Use only order numbers from get_customer_orders.');
      return confirmOrder(companyId, o);
    },
  };
}

class MovedOn extends Error {}

/** The landing chat's confirmation, step for step, in the bot's name. */
async function confirmOrder(companyId: string, o: BotRow, now: Date = new Date()): Promise<DoorAnswer> {
  const from = o.confirmationStatus as ConfirmationStatus;
  const view = () => db.order.findFirst({ where: { id: o.id, companyId }, select: BOT_SELECT }).then((r) => (r ? viewOf(companyId, r, true) : null));

  if (from === 'CONFIRMED') return { ok: true, order: (await view())!, already: true };
  if (ENDED.includes(from) || !isValidTransition(from, 'CONFIRMED')) {
    return refuse('This order is cancelled or cannot be confirmed from the chat. Offer transfer_to_human.');
  }
  if (o.shippingBatchId || o.trackingNumber || o.labelPrintedAt || o.shippingStatus !== 'NOT_READY') {
    return refuse('This order is already with shipping. Offer transfer_to_human.');
  }
  if (needsRegionFirst(o)) {
    return refuse('The order has no delivery city yet. Ask the customer for their city (one of "cities"), save it with update_customer_details, say the new amount, then ask again.');
  }
  if (parseVariantOptions(o.product?.variantOptions).length > 0 && o.items.some((i) => i.productId === o.productId && !i.variantSummary)) {
    return refuse('This product needs a size/colour per piece, which the bot cannot set. Tell the customer a colleague will complete it and call transfer_to_human.');
  }

  const actor = await bookkeepingActor(companyId);
  const country = o.countryId ? await db.country.findFirst({ where: { id: o.countryId, companyId }, select: { allowNegativeStock: true } }) : null;
  const note = (words: string) => `${BOT_ACTOR_AR}: ${words}`.slice(0, 2000);

  try {
    await db.$transaction(async (tx) => {
      await recordAttempt(tx, { companyId, orderId: o.id, actor, result: 'CONFIRMED', note: note('الزبون أكّد الطلب في محادثة واتساب') });
      // A second «yes» for the same customer and product is a person's question; the bot never answers it.
      const twins = await guardConfirmAgainstTwins(tx, {
        companyId,
        order: { id: o.id, customerId: o.customerId, productId: o.productId, storeId: o.storeId, replacesOrderId: o.replacesOrderId },
        now,
      });
      if (twins.length > 0) throw new TwinConfirmedRefusal(twins);

      const res = await tx.order.updateMany({
        where: { id: o.id, companyId, version: o.version },
        data: {
          confirmationStatus: 'CONFIRMED',
          status: 'CONFIRMED',
          confirmedAt: o.confirmedAt ?? now,
          confirmedById: null,
          ...resolvesFollowUp(o, now),
          version: { increment: 1 },
        },
      });
      if (res.count !== 1) throw new MovedOn();
      await reserveOrderLines(tx, o.id, { allowNegativeStock: country?.allowNegativeStock === true });
      await tx.orderStatusLog.create({
        data: {
          companyId,
          orderId: o.id,
          statusType: 'CONFIRMATION',
          previousValue: from,
          newValue: 'CONFIRMED',
          changedById: actor.id,
          changedByRole: actor.role,
          note: note('تأكيد'),
        },
      });
      await tx.orderActivity.create({
        data: {
          companyId,
          orderId: o.id,
          userId: null,
          action: 'STATUS_CHANGED',
          previousStatus: from,
          newStatus: 'CONFIRMED',
          metadata: JSON.stringify({ by: BOT_ACTOR_AR, workflow: 'CONFIRMATION' }),
        },
      });
      await tx.orderActivity.create({
        data: { companyId, orderId: o.id, userId: null, action: BOT_ACTION.CONFIRMED, metadata: JSON.stringify({ source: BOT_ACTOR_AR }) },
      });
    });
  } catch (e) {
    if (e instanceof TwinConfirmedRefusal) {
      return refuse('This customer already has a confirmed order for the same product: a person must decide. Tell the customer a colleague will contact them and call transfer_to_human.');
    }
    if (e instanceof MovedOn) return refuse('The order changed while confirming. Read it again with get_order_details, summarise, and ask again.');
    throw e;
  }

  await logAudit({
    companyId,
    userId: null,
    action: 'ORDER_CONFIRMED',
    entity: 'Order',
    entityId: o.id,
    previousData: { confirmationStatus: from, nextFollowUpAt: o.nextFollowUpAt },
    newData: { confirmationStatus: 'CONFIRMED', action: 'confirm', by: BOT_ACTOR_AR },
  });
  const after = await db.order.findFirst({ where: { id: o.id, companyId }, select: BOT_SELECT });
  await emitAppEvent(companyId, 'order.confirmed', {
    orderId: o.id,
    orderNumber: after?.orderNumber ?? o.orderNumber,
    confirmationStatus: 'CONFIRMED',
    previousStatus: from,
    total: Number(after?.totalAmount ?? o.totalAmount),
    currency: after?.currency ?? o.currency,
  });
  await queueConversions(companyId, 'order.confirmed', o.id);
  notify({
    companyId,
    storeId: o.storeId,
    audience: { permission: 'confirmation.supervise', userIds: [o.moderatorId] },
    actorId: null,
    title: 'تأكيد طلب',
    message: `الطلب #${o.orderNumber} أصبح بالحالة CONFIRMED بواسطة ${BOT_ACTOR_AR}.`,
    type: 'SYSTEM_ALERT',
    link: `/orders?highlight=${o.id}`,
    orderId: o.id,
  });
  return { ok: true, order: await viewOf(companyId, after ?? o, true) };
}
