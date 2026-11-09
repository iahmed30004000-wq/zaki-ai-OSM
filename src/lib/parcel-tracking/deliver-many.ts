import type { Prisma } from '@prisma/client';
import type { db as Db } from '../db';
import { COURIER_SAID } from '../couriers/courier-said';
import { courierSaidAgainst, type CourierSaidRow } from '../couriers/courier-said-read';
import { SHIPPING_STATUS_AR } from '../shipping-workflow';
import { PartialDeliveryRefused, recordPartialDelivery } from '../partial-delivery';
import { BULK_DELIVER_NOTE_AR, hasDeliverBox, type BulkDeliverReport, type BulkDeliverResult } from './bulk-deliver';

/**
 * «استلم» FOR A PAGE OF PARCELS — THE DOOR'S WHOLE DECISION, ON THE SERVER.
 *
 * The screen ticks the rows whose word is «تم التوصيل» (`canBulkDeliver`), but the screen is manners and this is the
 * rule: every parcel is judged HERE, at the moment of the press, by what the order and the company's newest line are
 * THEN — a word that changed since the page was drawn, a parcel somebody already recorded, a state that moved, a request
 * nobody has answered, an id of another store: each is refused with a short plain sentence while the rest go on.
 *
 * ── ONE TRANSACTION PER PARCEL ──
 *
 * A refusal, or a parcel that fails halfway, rolls back that parcel alone. The others are already committed and stay
 * committed: fifty parcels are fifty small doors, not one big one that a single bad row could take down.
 *
 * ── THE WRITE IS THE SINGLE DOOR'S, NOT A COPY OF IT ──
 *
 * A qualifying parcel is recorded by `recordPartialDelivery` with every unit taken — the same function the single
 * «استلم» (`outcome: 'ALL'`) calls — so the status, the lines, the customer's counters, the knock at the door and the
 * stock leaving the shelf are written by one piece of code. This file adds no arithmetic and writes no money: the
 * amount comes from the company's statement, as it always did.
 *
 * ── TWO PRESSES ON ONE PARCEL HAVE ONE WINNER ──
 *
 * Each parcel's row is locked (`SELECT … FOR UPDATE`, the form `hand-link` and `parcel-swap` already use) BEFORE it is
 * read, so a second press on the same parcel waits for the first, then reads it recorded and reports it so. Without the
 * lock both read «not recorded» and both write.
 */

type Tx = Prisma.TransactionClient;

/**
 * The states the SINGLE door accepts (`SETTLEABLE` in `partial-delivery.ts`, not exported there). A test drives the real
 * function over every state and holds this list to what it does, so the two cannot drift.
 */
export const SINGLE_DOOR_STATES = ['OUT_FOR_DELIVERY', 'SHIPPED', 'FAILED_DELIVERY'];

export type RefusalCode =
  | 'NOT_FOUND'
  | 'NO_LINES'
  | 'ALREADY_RECORDED'
  | 'NOT_AT_DOOR'
  | 'NO_BOX'
  | 'NO_WORD'
  | 'UNCLEAR_WORD'
  | 'OTHER_WORD'
  | 'CHANGE_PENDING'
  | 'FAILED';

/**
 * THE SENTENCES. Where the single door refuses the same thing, this is ITS sentence word for word (a test drives the
 * real function and compares); the rest are about the company's word, which the single door never asks.
 */
export const REFUSAL_AR: Record<Exclude<RefusalCode, 'OTHER_WORD'>, string> = {
  NOT_FOUND: 'الطلب غير موجود',
  NO_LINES: 'لا بنود لهذا الطلب',
  ALREADY_RECORDED: 'سُجِّل تسليم هذا الطلب مسبقاً',
  NOT_AT_DOOR: 'لا يمكن تسجيل التسليم قبل خروج الشحنة للتوصيل',
  NO_BOX: `حالته عندنا «${SHIPPING_STATUS_AR.FAILED_DELIVERY}» — سجّل تسليمه لحاله، مش بالجملة`,
  NO_WORD: 'الشركة ما قالت شي عن هالطرد',
  UNCLEAR_WORD: 'ما في كلمة واضحة من الشركة على هالطرد',
  CHANGE_PENDING: 'عليه طلب تعديل أو إلغاء أو تأجيل ما انجاوب — جاوبه أول',
  FAILED: 'تعذّر تسجيل هالطرد — جرّب مرة ثانية',
};

/** The newest word is something else: said with the company's own name for it, never the driver's free note. */
export const otherWordReason = (label: string): string => `آخر شي قالته الشركة: «${label}» — مش «تم التوصيل»`;

export type Verdict = { ok: true } | { ok: false; code: RefusalCode; reason: string };
const refuse = (code: Exclude<RefusalCode, 'OTHER_WORD'>): Verdict => ({ ok: false, code, reason: REFUSAL_AR[code] });

/**
 * THE STATE HALF: what the single door asks first, in its order, then the one thing the screen adds — the box.
 * The order's own dates are its marks: `deliveredAt` when anything was taken, `returnedAt` when nothing was.
 */
export function judgeState(order: { shippingStatus: string; deliveredAt: Date | null; returnedAt: Date | null }): Verdict {
  if (order.deliveredAt || order.returnedAt) return refuse('ALREADY_RECORDED');
  if (!SINGLE_DOOR_STATES.includes(order.shippingStatus)) return refuse('NOT_AT_DOOR');
  if (!hasDeliverBox(order.shippingStatus)) return refuse('NO_BOX');
  return { ok: true };
}

/**
 * THE WORD HALF: the company's NEWEST line about this parcel, judged by the very function the list draws the chip with
 * (`courierSaidAgainst`) — the code decides, the free note never does — and it must be «تم التوصيل».
 *
 * The newest line, not the newest «delivered» one: an older «تم التوصيل» followed by a newer «مؤجلة» has been taken back
 * by the company itself.
 */
export function judgeWord(shippingStatus: string, newestLine: CourierSaidRow | undefined, now: Date): Verdict {
  if (!newestLine) return refuse('NO_WORD');
  const said = courierSaidAgainst(shippingStatus, newestLine, now);
  if (!said) return refuse('UNCLEAR_WORD');
  if (said.status !== 'DELIVERED') return { ok: false, code: 'OTHER_WORD', reason: otherWordReason(said.label) };
  return { ok: true };
}

/** Every unit the order holds, gift units included — what the single door's `outcome: 'ALL'` expands to. */
export const everyUnitTaken = (items: readonly { id: string; quantity: number; freeQuantity: number }[]): { itemId: string; deliveredQty: number }[] =>
  items.map((i) => ({ itemId: i.id, deliveredQty: i.quantity + i.freeQuantity }));

/** A refusal found INSIDE the transaction by the shared function: the parcel's transaction rolls back and this is its answer. */
class RowStopped extends Error {
  constructor(readonly orderNumber: string, message: string) {
    super(message);
  }
}

/** A parcel's own budget; the default five seconds is thin for an order with many lines on a loaded database. */
const ROW_TIMEOUT_MS = 15_000;

export interface DeliverManyInput {
  companyId: string;
  storeId: string;
  userId: string;
  minorUnit: number;
  orderIds: readonly string[];
  now?: Date;
}

async function deliverOne(tx: Tx, p: Omit<DeliverManyInput, 'orderIds'> & { orderId: string; now: Date }): Promise<BulkDeliverResult> {
  // The row first: whoever takes it second sees what the first did (READ COMMITTED re-reads after the wait).
  await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${p.orderId} FOR UPDATE`;

  const order = await tx.order.findFirst({
    where: { id: p.orderId, companyId: p.companyId, storeId: p.storeId },
    select: {
      id: true, orderNumber: true, shippingStatus: true, deliveredAt: true, returnedAt: true,
      items: { select: { id: true, quantity: true, freeQuantity: true } },
    },
  });
  if (!order) return { orderId: p.orderId, orderNumber: null, ok: false, reason: REFUSAL_AR.NOT_FOUND };
  const stop = (reason: string): BulkDeliverResult => ({ orderId: order.id, orderNumber: order.orderNumber, ok: false, reason });

  if (order.items.length === 0) return stop(REFUSAL_AR.NO_LINES);
  const state = judgeState(order);
  if (!state.ok) return stop(state.reason);

  // The company's newest line about this parcel, with its company in the question (the table's index leads with it).
  const newest = await tx.orderActivity.findFirst({
    where: { orderId: order.id, companyId: p.companyId, action: COURIER_SAID },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { newStatus: true, metadata: true, createdAt: true },
  });
  const word = judgeWord(order.shippingStatus, newest ?? undefined, p.now);
  if (!word.ok) return stop(word.reason);

  /*
   * A REQUEST NOBODY HAS ANSWERED STOPS THE PRESS FOR THIS PARCEL — and only this door says so.
   *
   * The single «استلم» records a delivery whatever is pending: a delivery is a fact, and the order's own door blocks only the
   * FORWARD moves (contract invariant 7), not the end of the road. A press over fifty parcels decides for a person who has not
   * looked at each, so a parcel someone asked to cancel, postpone or edit is left for a person to look at (the same predicate
   * the order's door and the batch door ask: PENDING and blocking). It can only refuse more than the single door, never less.
   */
  const pending = await tx.orderChangeRequest.findFirst({
    where: { orderId: order.id, status: 'PENDING', blocking: true },
    select: { id: true },
  });
  if (pending) return stop(REFUSAL_AR.CHANGE_PENDING);

  try {
    await recordPartialDelivery(tx, {
      companyId: p.companyId,
      storeId: p.storeId,
      orderId: order.id,
      lines: everyUnitTaken(order.items),
      minorUnit: p.minorUnit,
      userId: p.userId,
      note: BULK_DELIVER_NOTE_AR,
    });
  } catch (e) {
    if (e instanceof PartialDeliveryRefused) throw new RowStopped(order.orderNumber, e.message);
    throw e;
  }
  return { orderId: order.id, orderNumber: order.orderNumber, ok: true };
}

/**
 * Judge and record the parcels, one transaction each, in the order asked. Never throws for a parcel: a refused or failed
 * one is a line of the report; only a failure to get as far as the first parcel (the caller's own context) is an error.
 */
export async function deliverMany(db: Pick<typeof Db, '$transaction'>, input: DeliverManyInput): Promise<BulkDeliverReport> {
  const now = input.now ?? new Date();
  const results: BulkDeliverResult[] = [];

  for (const orderId of [...new Set(input.orderIds)]) {
    try {
      results.push(await db.$transaction((tx) => deliverOne(tx, { ...input, orderId, now }), { timeout: ROW_TIMEOUT_MS }));
    } catch (e) {
      if (e instanceof RowStopped) {
        results.push({ orderId, orderNumber: e.orderNumber, ok: false, reason: e.message });
        continue;
      }
      // Only the kind of failure is logged, never the error's own text: a database error can carry the query's values.
      const kind = (e as { code?: string; name?: string } | null)?.code ?? (e as { name?: string } | null)?.name ?? 'unknown';
      console.error('deliver-many: a parcel failed and was rolled back:', orderId, kind);
      results.push({ orderId, orderNumber: null, ok: false, reason: REFUSAL_AR.FAILED });
    }
  }

  const delivered = results.filter((r) => r.ok).length;
  return { results, delivered, refused: results.length - delivered };
}
