import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { LANDING_PAGE_SOURCE, verifyAddonTokenWithin } from '../landing-pages';
import { ORDER_VALIDATION_ERROR_BODY } from '../landing-order-schema';
import { matchRegion } from '../regions';
import { isValidTransition, type ConfirmationStatus } from '../confirmation-workflow';
import { needsRegionFirst } from '../confirmation-queue';
import { TwinConfirmedRefusal, guardConfirmAgainstTwins } from '../confirmed-twin';
import { reserveOrderLines } from '../reservation';
import { endOrder, type EndOutcome } from '../order-cancel';
import { emitAppEvent } from '../apps/events';
import { queueConversions } from '../conversions/emit';
import { logAudit } from '../audit';
import { notify } from '../notify';
import { CITY_REFUSED, landingOrderFigures, lineUntouched, rewriteLandingOffer, type Refusal } from './landing-door';
import { V1_CODE, V1Fault } from './door';

/**
 * THE LANDING CONFIRMATION CHAT, AT THE SYSTEMS DOOR (contract `oms-lp.v1` §8).
 *
 * After a landing order is placed, the pages system opens a chat in which an automated assistant reviews the order with
 * the customer. Every decision it reaches — confirm, cancel, a new address, another offer, «call me» — comes through
 * here, and the pages system never writes an order's state itself. The conversation stays over there: nothing of it is
 * stored here but the decision and a short note.
 *
 * ── WHO MAY ASK ──
 *
 * The calling system's key names the company (`requireSystemToken`), and the customer is proved by the `addonToken`
 * the order door handed back: its signature, its kind, the order it names. Read here for 72 hours from the order
 * (`verifyAddonTokenWithin`), not the add-on link's thirty minutes. Only an order placed at the landing door answers;
 * any other is 404, as is another company's.
 *
 * ── THE SAME DECISIONS A PERSON MAKES, BY THE SAME HELPERS ──
 *
 * The agent's «تأكيد» is not a service: it lives in `POST /api/orders/[id]/confirmation`, behind a session. So a
 * confirmation here takes the same steps in the same order with the same helpers — the transition table, «no
 * governorate, no yes», the confirmed-twin guard under its lock, the version-guarded write, `reserveOrderLines` in the
 * same transaction, the status log, then `order.confirmed`, the conversions and the supervisors' notice after the
 * commit. A cancel is `endOrder`, the one helper every door that ends an order goes through, ending it as the agent's
 * «رفض» does (REJECTED, «غيّر رأيه», the customer's sentence as the note). A follow-up is the agent's «طلب معاودة
 * الاتصال»: FOLLOW_UP_REQUIRED. And each one records its contact attempt first, as the agent's screen does.
 *
 * The chat never answers a question that is a person's: a customer who already has a confirmed order for the same
 * product is not confirmed again here (the agent's door asks HER to say she knows; nobody here can).
 *
 * ── WHOSE NAME ──
 *
 * Every history line says «مساعد الطلبات الآلي (صفحة الهبوط)». Where a column may be empty (the activity, the audit,
 * the note, `confirmedById`) it is empty and the words carry the name: nobody on the staff confirmed this order, and
 * no commission or desk count may say otherwise. Two tables cannot be empty — the status log and the contact attempt
 * name a user — and there the company's administrator is the bookkeeping actor, as at the Telegram door, with the
 * assistant's name at the head of the line's note.
 */

export const CHAT_ACTOR_AR = 'مساعد الطلبات الآلي (صفحة الهبوط)';

/** How long after the order the chat may act on it. */
export const CHAT_TOKEN_HOURS = 72;

/** The history lines the chat writes, one per decision. Their words are `order-timeline.ts`'s. */
export const CHAT_ACTION = {
  CONFIRMED: 'LANDING_CHAT_CONFIRMED',
  CANCELLED: 'LANDING_CHAT_CANCELLED',
  ADDRESS: 'LANDING_CHAT_ADDRESS_CHANGED',
  OFFER: 'LANDING_CHAT_OFFER_CHANGED',
  FOLLOW_UP: 'LANDING_CHAT_FOLLOW_UP',
} as const;

const token = z.string().min(20).max(2048);
export const chatTokenSchema = z.object({ token });
export const chatCancelSchema = z.object({ token, reason: z.string().max(500).optional().nullable() });
export const chatAddressSchema = z.object({ token, city: z.string().max(120), address: z.string().max(500) });
export const chatOfferSchema = z.object({ token, offerId: z.string().min(1).max(64) });
export const chatFollowUpSchema = z.object({
  token,
  kind: z.enum(['callback', 'human']),
  note: z.string().max(1000).optional().nullable(),
  when: z.string().max(64).optional().nullable(),
});

type ChatAnswer = { ok: true; body: Record<string, unknown> } | Refusal;

const CHAT_SELECT = {
  id: true,
  orderNumber: true,
  version: true,
  createdAt: true,
  source: true,
  landingPageId: true,
  confirmationStatus: true,
  shippingStatus: true,
  shippingBatchId: true,
  trackingNumber: true,
  labelPrintedAt: true,
  currency: true,
  totalAmount: true,
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
  region: { select: { name: true } },
  store: { select: { name: true, countryId: true } },
  offer: { select: { id: true, name: true } },
  customer: { select: { fullName: true, phone: true, rawPhone: true, address: true, city: true } },
  items: { select: { productId: true, productName: true, quantity: true, freeQuantity: true, lineTotal: true }, orderBy: { createdAt: 'asc' } },
} as const;
type ChatRow = Prisma.OrderGetPayload<{ select: typeof CHAT_SELECT }>;

const ENDED: readonly string[] = ['REJECTED', 'CANCELLED'];
const DECIDED: readonly string[] = ['CONFIRMED', ...ENDED];

/** On a trolley, labelled, barcoded or past «not ready»: the parcel's life has begun, and the chat no longer edits it. */
function onShipment(o: { shippingStatus: string; shippingBatchId: string | null; trackingNumber: string | null; labelPrintedAt: Date | null }) {
  return !!o.shippingBatchId || !!o.trackingNumber || !!o.labelPrintedAt || o.shippingStatus !== 'NOT_READY';
}

/** «editable»: not confirmed, not rejected, not cancelled, and not on a shipment. */
export function chatEditable(o: {
  confirmationStatus: string;
  shippingStatus: string;
  shippingBatchId: string | null;
  trackingNumber: string | null;
  labelPrintedAt: Date | null;
}): boolean {
  return !DECIDED.includes(o.confirmationStatus) && !onShipment(o);
}

/** Placed at the landing door: the landing source, and no landing-page row of this product (that page lives elsewhere). */
function fromTheLandingDoor(o: { source: string; landingPageId: string | null }) {
  return o.source === LANDING_PAGE_SOURCE && o.landingPageId === null;
}

const refuse = (status: number, error: string, reason: string): Refusal => ({ ok: false, status, body: { error, reason } });
const TOKEN_REFUSED: Refusal = { ok: false, status: 401, body: { error: 'رابط المحادثة غير صالح أو انتهت صلاحيته' } };
const NOT_EDITABLE = () => refuse(409, 'لم يعد ممكنًا تعديل هذا الطلب من هنا — سيتواصل معك فريقنا', 'NOT_EDITABLE');
const MOVED_ON = () => refuse(409, 'تغيّر الطلب أثناء العمل عليه — أعد المحاولة', 'ORDER_MOVED_ON');

/** The order this token proves, of this company, placed at the landing door and still inside the chat's 72 hours. */
async function orderOfToken(companyId: string, orderNumber: string, raw: string, now: Date): Promise<{ ok: true; order: ChatRow } | Refusal> {
  const tok = await verifyAddonTokenWithin(raw, CHAT_TOKEN_HOURS, now);
  if (!tok || tok.orderNumber !== orderNumber) return TOKEN_REFUSED;
  const order = await db.order.findFirst({ where: { companyId, id: tok.orderId, orderNumber }, select: CHAT_SELECT });
  if (!order || !fromTheLandingDoor(order)) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');
  if (now.getTime() - order.createdAt.getTime() > CHAT_TOKEN_HOURS * 3_600_000) return TOKEN_REFUSED;
  return { ok: true, order };
}

/** The order as the chat reads it. Every figure is this product's: the stored total, and `landingOrderFigures`. */
async function viewOf(companyId: string, o: ChatRow) {
  const figures = await landingOrderFigures(companyId, {
    productId: o.productId,
    offerId: o.offerId,
    regionName: o.region?.name ?? null,
    totalAmount: Number(o.totalAmount),
    priceIncludesDelivery: o.priceIncludesDelivery,
  });
  return {
    orderNumber: o.orderNumber,
    createdAt: o.createdAt.toISOString(),
    confirmationStatus: o.confirmationStatus,
    editable: chatEditable(o),
    storeName: o.store?.name ?? figures.storeName,
    currency: o.currency,
    minorUnit: figures.minorUnit,
    paymentMethod: 'COD',
    customer: {
      name: o.customer.fullName,
      phone: o.customer.rawPhone || o.customer.phone,
      city: o.region?.name ?? o.customer.city,
      address: o.deliveryAddress ?? o.customer.address,
      notes: o.customerNotes ?? '',
    },
    items: o.items.map((i) => {
      const main = i.productId === o.productId;
      return {
        productId: i.productId,
        name: i.productName,
        offerId: main ? o.offerId : null,
        offerName: main ? o.offer?.name ?? null : null,
        quantity: i.quantity,
        freeQuantity: i.freeQuantity,
        price: Number(i.lineTotal),
      };
    }),
    offers: figures.offers,
    total: Number(o.totalAmount),
    cod: figures.cod,
    deliveryFee: figures.deliveryFee,
    deliveryIncluded: figures.deliveryIncluded,
    feeKnown: figures.feeKnown,
    feeExact: figures.feeExact,
  };
}

/** The order read again after a write, so the answer is what is stored. */
async function freshView(companyId: string, orderId: string) {
  const o = await db.order.findFirst({ where: { companyId, id: orderId }, select: CHAT_SELECT });
  if (!o) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');
  return viewOf(companyId, o);
}

/**
 * THE USER TWO TABLES NEED. `OrderStatusLog.changedById` and `OrderContactAttempt.employeeId` cannot be empty, so — as
 * the Telegram door does for its status log — the company's active administrator is written there, and the assistant's
 * name heads the line's note. Never a client-supplied identity.
 */
async function bookkeepingActor(companyId: string): Promise<{ id: string; role: string }> {
  const admin =
    (await db.user.findFirst({ where: { companyId, role: 'COMPANY_ADMIN', status: 'ACTIVE' }, select: { id: true, role: true } })) ??
    (await db.user.findFirst({ where: { companyId, role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { id: true, role: true } }));
  if (!admin) throw new V1Fault(500, V1_CODE.INTERNAL, 'No active company administrator to record the change under');
  return admin;
}

/** The line of the note every row carries: the assistant's name first. */
const said = (words: string) => `${CHAT_ACTOR_AR}: ${words}`.slice(0, 2000);

/** The contact attempt the agent's screen records before every decision — here, by the chat. */
async function recordAttempt(
  tx: Prisma.TransactionClient,
  a: { companyId: string; orderId: string; actor: { id: string; role: string }; result: 'CONFIRMED' | 'REJECTED' | 'CALLBACK_REQUESTED'; note: string; nextFollowUpAt?: Date | null }
) {
  const last = await tx.orderContactAttempt.findFirst({
    where: { orderId: a.orderId },
    orderBy: { attemptNumber: 'desc' },
    select: { attemptNumber: true },
  });
  await tx.orderContactAttempt.create({
    data: {
      companyId: a.companyId,
      orderId: a.orderId,
      employeeId: a.actor.id,
      employeeRole: a.actor.role,
      attemptNumber: (last?.attemptNumber ?? 0) + 1,
      contactMethod: 'OTHER',
      result: a.result,
      note: a.note,
      nextFollowUpAt: a.nextFollowUpAt ?? null,
    },
  });
}

/** The history line the chat's decision leaves, in the assistant's name. */
function chatLine(tx: Prisma.TransactionClient, companyId: string, orderId: string, action: string, extra: Record<string, unknown> = {}) {
  return tx.orderActivity.create({
    data: { companyId, orderId, userId: null, action, metadata: JSON.stringify({ source: CHAT_ACTOR_AR, ...extra }) },
  });
}

/** A pending follow-up is resolved by a decision, as at the agent's door — by nobody on the staff. */
function resolvesFollowUp(o: { nextFollowUpAt: Date | null; followUpStatus: string | null }, now: Date) {
  return o.nextFollowUpAt && (!o.followUpStatus || o.followUpStatus === 'SCHEDULED')
    ? { followUpStatus: 'COMPLETED', followUpResolvedAt: now, followUpResolvedById: null }
    : {};
}

class MovedOn extends Error {
  constructor() {
    super('ORDER_MOVED_ON');
  }
}
class EndRefused extends Error {
  constructor(readonly outcome: Extract<EndOutcome, { ok: false }>) {
    super(outcome.code);
  }
}

/* ───────────────────────────── GET /orders/:orderNumber ───────────────────────────── */

export async function readChatOrder(companyId: string, orderNumber: string, raw: string, now: Date = new Date()): Promise<ChatAnswer> {
  const found = await orderOfToken(companyId, orderNumber, raw, now);
  if (!found.ok) return found;
  const order = await viewOf(companyId, found.order);
  return { ok: true, body: order };
}

/* ───────────────────────────── POST …/confirm ───────────────────────────── */

export async function confirmFromChat(
  companyId: string,
  orderNumber: string,
  input: z.infer<typeof chatTokenSchema>,
  now: Date = new Date()
): Promise<ChatAnswer> {
  const found = await orderOfToken(companyId, orderNumber, input.token, now);
  if (!found.ok) return found;
  const o = found.order;
  const from = o.confirmationStatus as ConfirmationStatus;

  // Confirmed already: the same answer, and nothing is written, announced or reserved twice.
  if (from === 'CONFIRMED') {
    const order = await viewOf(companyId, o);
    return { ok: true, body: { order, already: true } };
  }
  if (ENDED.includes(from) || !isValidTransition(from, 'CONFIRMED')) {
    return refuse(409, 'هذا الطلب ملغى ولا يمكن تأكيده', 'NOT_ELIGIBLE');
  }
  // No governorate, no yes (the agent's door asks the same, of everyone).
  if (needsRegionFirst(o)) return refuse(409, 'نحتاج المحافظة قبل تأكيد الطلب — سيتواصل معك فريقنا', 'REGION_REQUIRED');

  const actor = await bookkeepingActor(companyId);
  const country = o.countryId
    ? await db.country.findFirst({ where: { id: o.countryId, companyId }, select: { allowNegativeStock: true } })
    : null;

  try {
    await db.$transaction(async (tx) => {
      await recordAttempt(tx, { companyId, orderId: o.id, actor, result: 'CONFIRMED', note: said('الزبون أكّد الطلب في المحادثة') });

      // The second «yes» for the same customer is a person's question; the chat never answers it.
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

      // Reservation follows the decision, inside this transaction — as at the agent's door.
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
          note: said('تأكيد'),
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
          metadata: JSON.stringify({ by: CHAT_ACTOR_AR, workflow: 'CONFIRMATION' }),
        },
      });
      await chatLine(tx, companyId, o.id, CHAT_ACTION.CONFIRMED);
    });
  } catch (e) {
    if (e instanceof TwinConfirmedRefusal) {
      return refuse(409, 'عندك طلب مؤكد لنفس المنتج — سيتواصل معك فريقنا ليتأكد', 'TWIN_CONFIRMED');
    }
    if (e instanceof MovedOn) return MOVED_ON();
    throw e;
  }

  await logAudit({
    companyId,
    userId: null,
    action: 'ORDER_CONFIRMED',
    entity: 'Order',
    entityId: o.id,
    previousData: { confirmationStatus: from, nextFollowUpAt: o.nextFollowUpAt },
    newData: { confirmationStatus: 'CONFIRMED', action: 'confirm', by: CHAT_ACTOR_AR },
  });

  const fresh = await db.order.findFirst({ where: { companyId, id: o.id }, select: CHAT_SELECT });
  // After the commit, as the agent's door announces it: the same event, the same fields.
  await emitAppEvent(companyId, 'order.confirmed', {
    orderId: o.id,
    orderNumber: fresh?.orderNumber ?? o.orderNumber,
    confirmationStatus: 'CONFIRMED',
    previousStatus: from,
    total: Number(fresh?.totalAmount ?? o.totalAmount),
    currency: fresh?.currency ?? o.currency,
  });
  await queueConversions(companyId, 'order.confirmed', o.id);
  notify({
    companyId,
    storeId: o.storeId,
    audience: { permission: 'confirmation.supervise', userIds: [o.moderatorId] },
    actorId: null,
    title: 'تأكيد طلب',
    message: `الطلب #${o.orderNumber} أصبح بالحالة CONFIRMED بواسطة ${CHAT_ACTOR_AR}.`,
    type: 'SYSTEM_ALERT',
    link: `/orders?highlight=${o.id}`,
    orderId: o.id,
  });

  const order = fresh ? await viewOf(companyId, fresh) : await freshView(companyId, o.id);
  return { ok: true, body: { order } };
}

/* ───────────────────────────── POST …/cancel ───────────────────────────── */

/** The structured reason the agent picks when the customer changes their mind before the yes. */
const CHANGED_MIND = 'CUSTOMER_CHANGED_MIND';

export async function cancelFromChat(
  companyId: string,
  orderNumber: string,
  input: z.infer<typeof chatCancelSchema>,
  now: Date = new Date()
): Promise<ChatAnswer> {
  const found = await orderOfToken(companyId, orderNumber, input.token, now);
  if (!found.ok) return found;
  const o = found.order;
  const from = o.confirmationStatus;

  if (ENDED.includes(from)) {
    const order = await viewOf(companyId, o);
    return { ok: true, body: { order, already: true } };
  }
  if (from === 'CONFIRMED' || onShipment(o) || !isValidTransition(from, 'REJECTED')) {
    return refuse(409, 'الطلب مؤكد أو خرج للشحن — سيتواصل معك فريقنا بخصوص الإلغاء', 'NOT_ELIGIBLE');
  }

  const actor = await bookkeepingActor(companyId);
  const reason = (input.reason ?? '').trim();
  const words = reason || 'الزبون تراجع عن الطلب قبل التأكيد';

  let ended: Extract<EndOutcome, { ok: true }>;
  try {
    ended = await db.$transaction(async (tx) => {
      await recordAttempt(tx, { companyId, orderId: o.id, actor, result: 'REJECTED', note: said(words) });
      // The one helper every door that ends an order goes through — in this transaction, as the attempts door calls it.
      const outcome = await endOrder({
        orderId: o.id,
        companyId,
        storeId: null,
        by: { id: actor.id, name: CHAT_ACTOR_AR, role: actor.role },
        door: 'CONFIRMATION',
        kind: 'CANCEL',
        endAs: 'REJECTED',
        reason: CHANGED_MIND,
        rejectionNote: reason || null,
        data: resolvesFollowUp(o, now),
        logNote: said(words),
        noteBody: null,
        expectedVersion: o.version,
        tx,
      });
      if (!outcome.ok) throw new EndRefused(outcome);
      await chatLine(tx, companyId, o.id, CHAT_ACTION.CANCELLED, { notes: words });
      return outcome;
    });
  } catch (e) {
    if (e instanceof EndRefused) return refuse(409, e.outcome.error, e.outcome.code);
    throw e;
  }
  // Committed: only now is anybody told (a REJECTED end announces nothing to the apps, as at the agent's door).
  await ended.afterCommit();

  await logAudit({
    companyId,
    userId: null,
    action: 'ORDER_REJECTED',
    entity: 'Order',
    entityId: o.id,
    previousData: { confirmationStatus: from, nextFollowUpAt: o.nextFollowUpAt },
    newData: { confirmationStatus: 'REJECTED', rejectionReason: CHANGED_MIND, action: 'reject', by: CHAT_ACTOR_AR },
  });
  notify({
    companyId,
    storeId: o.storeId,
    audience: { permission: 'confirmation.supervise', userIds: [o.moderatorId] },
    actorId: null,
    title: 'رفض طلب',
    message: `الطلب #${o.orderNumber} أصبح بالحالة REJECTED بواسطة ${CHAT_ACTOR_AR}.`,
    type: 'SYSTEM_ALERT',
    link: `/orders?highlight=${o.id}`,
    orderId: o.id,
  });

  const order = await freshView(companyId, o.id);
  return { ok: true, body: { order } };
}

/* ───────────────────────────── POST …/address ───────────────────────────── */

export async function changeAddressFromChat(
  companyId: string,
  orderNumber: string,
  input: z.infer<typeof chatAddressSchema>,
  now: Date = new Date()
): Promise<ChatAnswer> {
  const found = await orderOfToken(companyId, orderNumber, input.token, now);
  if (!found.ok) return found;
  const o = found.order;
  if (!chatEditable(o)) return NOT_EDITABLE();

  // A city the courier's fee table knows, by the matcher every intake door uses — or the same refusal the quote gives.
  const countryId = o.countryId ?? o.store?.countryId ?? null;
  const regions = countryId
    ? await db.region.findMany({ where: { countryId, isActive: true }, select: { id: true, name: true } })
    : [];
  const region = matchRegion(regions, input.city.trim());
  if (!region) return CITY_REFUSED;
  const street = input.address.trim();
  if (!street) {
    return { ok: false, status: 400, body: { ...ORDER_VALIDATION_ERROR_BODY, fieldErrors: { address: 'يرجى كتابة العنوان.' } } };
  }

  try {
    await db.$transaction(async (tx) => {
      // The parcel's own address and governorate, as the order's PATCH writes them; the customer keeps the latest street.
      const res = await tx.order.updateMany({
        where: { id: o.id, companyId, version: o.version },
        data: { regionId: region.id, deliveryAddress: street, version: { increment: 1 } },
      });
      if (res.count !== 1) throw new MovedOn();
      await tx.customer.update({ where: { id: o.customerId }, data: { address: street } });
      await chatLine(tx, companyId, o.id, CHAT_ACTION.ADDRESS, { fields: ['customerAddress', 'regionId'] });
    });
  } catch (e) {
    if (e instanceof MovedOn) return MOVED_ON();
    throw e;
  }

  await logAudit({
    companyId,
    userId: null,
    action: CHAT_ACTION.ADDRESS,
    entity: 'Order',
    entityId: o.id,
    previousData: { regionId: o.regionId },
    newData: { regionId: region.id, fields: ['customerAddress', 'regionId'], by: CHAT_ACTOR_AR },
  });

  const order = await freshView(companyId, o.id);
  return { ok: true, body: { order } };
}

/* ───────────────────────────── POST …/offer ───────────────────────────── */

export async function changeOfferFromChat(
  companyId: string,
  orderNumber: string,
  input: z.infer<typeof chatOfferSchema>,
  now: Date = new Date()
): Promise<ChatAnswer> {
  const found = await orderOfToken(companyId, orderNumber, input.token, now);
  if (!found.ok) return found;
  const o = found.order;
  if (!chatEditable(o)) return NOT_EDITABLE();

  // The offer it already has: nothing to write.
  if (o.offerId === input.offerId) {
    const order = await viewOf(companyId, o);
    return { ok: true, body: { order } };
  }

  // The same write as the offer after the order — the catalogue's price, the door's own figures — without its «once».
  const result = await rewriteLandingOffer(
    companyId,
    o.id,
    input.offerId,
    {
      blocked: async (row) => (chatEditable(row) && lineUntouched(row) ? null : 'NOT_EDITABLE'),
      pick: (offers, _current, offerId) => offers.find((f) => f.id === offerId) ?? null,
      action: CHAT_ACTION.OFFER,
      by: CHAT_ACTOR_AR,
      source: CHAT_ACTOR_AR,
    },
    now
  );
  if (!result.ok) {
    if (result.reason === 'OFFER_GONE') return refuse(404, 'هذا العرض غير متاح لهذا المنتج', 'OFFER_NOT_FOUND');
    if (result.reason === 'ALREADY_ADDED') return MOVED_ON();
    return NOT_EDITABLE();
  }

  await logAudit({
    companyId,
    userId: null,
    action: CHAT_ACTION.OFFER,
    entity: 'Order',
    entityId: o.id,
    previousData: { offerId: o.offerId, total: Number(o.totalAmount) },
    newData: { offerId: result.offer.id, total: result.total, by: CHAT_ACTOR_AR },
  });

  const order = await freshView(companyId, o.id);
  return { ok: true, body: { order } };
}

/* ───────────────────────────── POST …/follow-up ───────────────────────────── */

const FOLLOW_UP_WORDS = {
  callback: 'الزبون طلب أن يتصل به موظف',
  human: 'الزبون طلب التحدث مع موظف',
} as const;

export async function followUpFromChat(
  companyId: string,
  orderNumber: string,
  input: z.infer<typeof chatFollowUpSchema>,
  now: Date = new Date()
): Promise<ChatAnswer> {
  const found = await orderOfToken(companyId, orderNumber, input.token, now);
  if (!found.ok) return found;
  const o = found.order;
  const from = o.confirmationStatus;
  if (ENDED.includes(from)) return refuse(409, 'هذا الطلب ملغى', 'NOT_ELIGIBLE');

  // A date, when the customer named one: in the future, by the server's clock (one minute of grace, as the agent's door).
  let when: Date | null = null;
  if (input.when) {
    when = new Date(input.when);
    if (Number.isNaN(when.getTime()) || when.getTime() < now.getTime() - 60_000) {
      return { ok: false, status: 400, body: { ...ORDER_VALIDATION_ERROR_BODY, fieldErrors: { when: 'موعد الاتصال يجب أن يكون في المستقبل.' } } };
    }
  }

  const note = (input.note ?? '').trim();
  const words = `${FOLLOW_UP_WORDS[input.kind]}${when ? ` — الموعد: ${when.toISOString()}` : ''}${note ? ` — ${note}` : ''}`;
  /*
   * The agent's «طلب معاودة الاتصال» moves the order to FOLLOW_UP_REQUIRED. A confirmed order stays confirmed (the note is
   * for whoever handles it), and a postponed one keeps its postponement: the transition table does not lead from there.
   */
  const target: ConfirmationStatus | null =
    from === 'CONFIRMED' ? null : from === 'FOLLOW_UP_REQUIRED' || isValidTransition(from, 'FOLLOW_UP_REQUIRED') ? 'FOLLOW_UP_REQUIRED' : null;
  const actor = await bookkeepingActor(companyId);

  try {
    await db.$transaction(async (tx) => {
      if (from !== 'CONFIRMED') {
        await recordAttempt(tx, { companyId, orderId: o.id, actor, result: 'CALLBACK_REQUESTED', note: said(words), nextFollowUpAt: when });
      }
      if (target) {
        const res = await tx.order.updateMany({
          where: { id: o.id, companyId, version: o.version },
          data: {
            confirmationStatus: target,
            ...(when
              ? {
                  nextFollowUpAt: when,
                  followUpStatus: 'SCHEDULED',
                  followUpReason: input.kind === 'callback' ? 'CUSTOMER_REQUESTED_CALLBACK' : 'OTHER',
                }
              : {}),
            version: { increment: 1 },
          },
        });
        if (res.count !== 1) throw new MovedOn();
        if (target !== from) {
          await tx.orderStatusLog.create({
            data: {
              companyId,
              orderId: o.id,
              statusType: 'CONFIRMATION',
              previousValue: from,
              newValue: target,
              changedById: actor.id,
              changedByRole: actor.role,
              note: said(words),
            },
          });
          await tx.orderActivity.create({
            data: {
              companyId,
              orderId: o.id,
              userId: null,
              action: 'STATUS_CHANGED',
              previousStatus: from,
              newStatus: target,
              metadata: JSON.stringify({ by: CHAT_ACTOR_AR, workflow: 'CONFIRMATION' }),
            },
          });
        }
      }
      // The note the confirmation desk reads on the order.
      await tx.orderNote.create({
        data: {
          companyId,
          orderId: o.id,
          authorId: null,
          kind: 'follow_up',
          body: said(words),
        },
      });
      await chatLine(tx, companyId, o.id, CHAT_ACTION.FOLLOW_UP, { notes: words });
    });
  } catch (e) {
    if (e instanceof MovedOn) return MOVED_ON();
    throw e;
  }

  await logAudit({
    companyId,
    userId: null,
    action: 'CONFIRMATION_WORKFLOW_ACTION',
    entity: 'Order',
    entityId: o.id,
    previousData: { confirmationStatus: from, nextFollowUpAt: o.nextFollowUpAt },
    newData: { confirmationStatus: target ?? from, action: 'follow_up', kind: input.kind, by: CHAT_ACTOR_AR },
  });

  const order = await freshView(companyId, o.id);
  return { ok: true, body: { order } };
}
