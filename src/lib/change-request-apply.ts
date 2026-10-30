import type { SessionUser } from '@/types/auth';
import { BEFORE_OPERATIONS, mayDecide } from './change-request-routing';
import {
  CHANGEABLE_FIELDS, LINES_FIELD, changeFieldLabel, readLinesChange,
  type ApprovedLineEdit, type ChangeValue, type LinesChange,
} from './change-request-fields';
import { INTENT_AR, type ChangeIntent } from './change-request-intent';

/**
 * APPLYING AN APPROVED CHANGE REQUEST.
 *
 * The missing last step. Once a waybill is printed, or the parcel is in a
 * handed-over batch, the order is SEALED: the address the driver holds and
 * the amount he collects are fixed somewhere we do not control. The seal
 * says so itself — "what was a direct edit becomes a change request:
 * somebody who can still reach the courier decides". Somebody did decide.
 * And then the edit that carried the decision out hit the same seal, and
 * was refused. An approved request on a sealed order could not be applied
 * by anyone.
 *
 * So an approved request is now the one authority that passes the seal —
 * and only as far as it was approved:
 *
 *   The browser sends the request's id and nothing else. The VALUES come
 *   from the approved request, on the server. There is no way to apply a
 *   quantity other than the one that was approved, or to slip a second
 *   field in beside it under the request's authority.
 *
 *   Once. An applied request cannot be applied again.
 *
 *   After confirmation only. Before it the order is still on somebody's
 *   call list and is edited in the ordinary way.
 *
 *   By somebody who could have decided it — the same rule as approving.
 *
 * The edit itself still runs through the order's own route, so quantity,
 * discount and product go through the money path exactly as a direct edit
 * would, and nothing here computes an amount.
 */

/**
 * Change-request fields and the order-edit field each one becomes.
 *
 * ONE is missing on purpose now, and the refusal names it: the order edit
 * has no offer. A request for it could be raised and approved but never
 * carried out; saying so is better than applying half of it.
 *
 * The city used to be the other one — and that was the wrong answer to
 * the right observation. The order ships to a REGION, so the request now
 * carries `regionId`, which the order route does write. A door that
 * accepts a request it can never carry out is worse than one that refuses
 * it at the start.
 */
const APPLIES_AS: Partial<Record<(typeof CHANGEABLE_FIELDS)[number], string>> = {
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  customerAltPhone: 'customerAltPhone',
  customerAddress: 'customerAddress',
  customerNotes: 'customerNotes',
  regionId: 'regionId',
  quantity: 'quantity',
  discountAmount: 'discountAmount',
  productId: 'productId',
  // The order route names it the same and recomputes the amount due from
  // it, so the invoice and the COD follow the approval by themselves —
  // «وينعكس هذا على الفاتورة».
  sellingPrice: 'sellingPrice',
};

export interface ApplySource {
  id: string;
  orderId: string;
  status: string;
  appliedAt: Date | string | null;
  changes: unknown;
  /** EDIT | CANCEL | POSTPONE. Absent on rows written before it existed. */
  intent?: string | null;
}

export type Expansion =
  | {
      ok: true;
      fields: Record<string, ChangeValue>;
      /**
       * THE LINES THE REQUEST APPROVED, line by line — present only when it carried the `lines` key (so a request of
       * plain fields expands to exactly what it always did). Never read from the database here: binding them to the stored
       * lines is the order route's job, in the same breath as the write.
       */
      lineEdits?: ApprovedLineEdit[];
      /** What the decider was shown as the order's money after the edit, to be compared and never believed. */
      linesSnapshot?: LinesChange['snapshot'];
    }
  | { ok: false; status: number; code: string; error: string };

/**
 * The order-edit fields an approved request stands for.
 *
 * Checked before anything else is read, so a request that can never be
 * applied is refused with its reason rather than half-way through an edit.
 */
export function expandApproved(request: ApplySource): Expansion {
  /**
   * AND IT IS AN EDIT.
   *
   * A cancellation carries no fields, so without this it fell out the far
   * end as «لا حقول في طلب التعديل لتطبيقها» — true, and no help at all to
   * somebody who pressed «طبّق» on a cancellation and is now looking for
   * the button that does work.
   */
  const asked = (request.intent ?? 'EDIT') as ChangeIntent;
  if (asked !== 'EDIT') {
    return {
      ok: false,
      status: 409,
      code: 'WRONG_INTENT',
      error: `هذا الطلب يطلب ${INTENT_AR[asked]}، لا تعديل حقل — نفِّذه من زرّه.`,
    };
  }
  if (request.status !== 'APPROVED') {
    return { ok: false, status: 409, code: 'NOT_APPROVED', error: 'طلب التعديل غير معتمَد — لا يُطبَّق إلا بعد الاعتماد' };
  }
  if (request.appliedAt) {
    return { ok: false, status: 409, code: 'ALREADY_APPLIED', error: 'طُبّق هذا التعديل مسبقاً' };
  }

  const changes = (request.changes ?? {}) as Record<string, { to?: ChangeValue } | undefined>;
  const fields: Record<string, ChangeValue> = {};
  const cannot: string[] = [];

  /*
   * THE LINES, READ STRICTLY AND BEFORE THE LOOP.
   *
   * `lines` is not a `{ from, to }`: the loop below skips anything without a `to`, so left to it a request made of
   * `lines` alone would have fallen out as «لا حقول لتطبيقها» and a request of `lines` plus a note would have applied the
   * note and dropped the goods without a word. It is read here or it is refused here.
   */
  const lines = readLinesChange(request.changes);
  if (!lines.ok) {
    return { ok: false, status: 422, code: 'LINES_INVALID', error: `أسطر طلب التعديل غير صالحة — ${lines.error}` };
  }
  if (lines.value && ((lines.value.removed?.length ?? 0) > 0 || (lines.value.added?.length ?? 0) > 0)) {
    return {
      ok: false,
      status: 422,
      code: 'NOT_APPLICABLE',
      error: 'إضافة سطر أو حذفه من هنا لسا مش مدعوم — ألغِ الطلب وأنشئ جديداً.',
    };
  }
  // One request, one way to say the goods: the shorthand (a quantity, a product, a price) beside `lines` would be two
  // answers to one question, and the apply door would have to pick.
  if (lines.value && ['quantity', 'productId', 'sellingPrice'].some((k) => changes[k] !== undefined)) {
    return {
      ok: false,
      status: 422,
      code: 'LINES_AND_FLAT',
      error: 'الطلب بيجمع أسطر مع كمية أو سعر أو منتج مفرد — ما بينطبق. ارفع طلباً واحداً بشكل واحد.',
    };
  }

  for (const [field, change] of Object.entries(changes)) {
    if (field === LINES_FIELD) continue;
    if (!change || !('to' in change)) continue;
    const target = APPLIES_AS[field as keyof typeof APPLIES_AS];
    if (!target) {
      cannot.push(changeFieldLabel(field));
      continue;
    }
    fields[target] = change.to ?? null;
  }

  if (cannot.length > 0) {
    return {
      ok: false,
      status: 422,
      code: 'NOT_APPLICABLE',
      error: `لا يمكن تطبيق «${cannot.join('، ')}» من هنا — عدّلها يدوياً ثم أغلق الطلب.`,
    };
  }
  if (Object.keys(fields).length === 0 && !lines.value) {
    return { ok: false, status: 422, code: 'NOTHING_TO_APPLY', error: 'لا حقول في طلب التعديل لتطبيقها' };
  }
  return {
    ok: true,
    fields,
    ...(lines.value ? { lineEdits: lines.value.edits, linesSnapshot: lines.value.snapshot } : {}),
  };
}

/**
 * The keys a request-authorised edit may carry besides the request id.
 *
 * `courierNotified` is on this list and is NOT a field of the order. It says
 * «the courier has been told», which is what the seal now asks for before an
 * approved change is written onto a parcel they are already holding. It
 * changes nothing about WHAT is applied — the values still come from what
 * was approved — so it cannot be used to smuggle a second change through,
 * which is the whole reason this list is short.
 */
const ALLOWED_ALONGSIDE = new Set(['changeRequestId', 'expectedVersion', 'courierNotified']);

/**
 * Anything in the body beyond the request id is refused.
 *
 * The request's authority passes the seal. Letting another field ride along
 * with it would make "an approved change of quantity" a way to change the
 * address of a parcel that has already left.
 */
export function strayFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => body[k] !== undefined && !ALLOWED_ALONGSIDE.has(k));
}

export type OrderVerdict = { ok: true } | { ok: false; status: number; code: string; error: string };

/** The checks that need the order and the person, once both are loaded. */
export function mayApply(
  user: SessionUser,
  request: { orderId: string },
  /**
   * `handedToCourier` travels with the order because the warehouse may
   * carry out a decision until the courier takes the parcel, and not
   * after. Absent reads as «taken», which denies rather than grants.
   */
  order: {
    id: string;
    confirmationStatus: string;
    claimedById: string | null;
    handedToCourier?: boolean;
  }
): OrderVerdict {
  if (request.orderId !== order.id) {
    return { ok: false, status: 404, code: 'WRONG_ORDER', error: 'طلب التعديل لا يخص هذا الطلب' };
  }
  if (BEFORE_OPERATIONS.includes(order.confirmationStatus)) {
    return {
      ok: false,
      status: 409,
      code: 'NOT_CONFIRMED',
      error: 'الطلب لم يُؤكَّد بعد — عدّله مباشرة من شاشته',
    };
  }
  const routing = mayDecide(user, order);
  if (!routing.allowed) {
    return { ok: false, status: 403, code: 'NOT_THE_DECIDER', error: routing.reason ?? 'لا تملك صلاحية تطبيق هذا التعديل' };
  }
  return { ok: true };
}

/**
 * AN APPROVED REQUEST AS THE AUTHORITY FOR A CANCELLATION OR A HOLD.
 *
 * The edit path set this precedent and states its reasoning: an approved
 * request is «the one authority that passes the seal», because it carries a
 * raiser, a reason, a decider, an SLA that escalates and an audit row —
 * strictly more control than the direct edit it replaces, not less.
 *
 * The other two intents need it for the same reason and one more. Measured
 * on this company: `control.change_requests` is held by MANAGER,
 * COMPANY_ADMIN, DELIVERY_MANAGER and CONFIRMATION_SUPERVISOR, while
 * cancelling directly needs `orders.unlock` — MANAGER, COMPANY_ADMIN and
 * SUPER_ADMIN — and standing a shipment down needs `ops.ship`, which is
 * neither. So two of the four people the queue is addressed to could
 * approve a cancellation and then not carry it out, and the request would
 * sit in «بانتظار التطبيق» until somebody with a third permission noticed.
 *
 * An approval that cannot be acted on is not an approval. So the decision
 * is the authority, and the permission still governs the door with no
 * decision behind it.
 *
 * What it does NOT do is widen anything else: the carry-out keeps every one
 * of its own guards. `assertCancellable` still refuses once the goods have
 * left, and answers with the return that is the real remedy there.
 */
export function authorises(
  /**
   * The four columns the answer turns on, and not `changes` — a cancellation
   * has none, and demanding the field would make the caller select a column
   * it has no use for.
   */
  request: Pick<ApplySource, 'orderId' | 'status' | 'appliedAt' | 'intent'>,
  intent: ChangeIntent,
  orderId: string
): OrderVerdict {
  if (request.orderId !== orderId) {
    return { ok: false, status: 404, code: 'WRONG_ORDER', error: 'طلب التعديل لا يخص هذا الطلب' };
  }
  // A row written before the column existed is an edit, and says so.
  const asked = (request.intent ?? 'EDIT') as ChangeIntent;
  if (asked !== intent) {
    return {
      ok: false,
      status: 409,
      code: 'WRONG_INTENT',
      error: `هذا الطلب يطلب ${INTENT_AR[asked]}، لا ${INTENT_AR[intent]}`,
    };
  }
  if (request.status !== 'APPROVED') {
    return { ok: false, status: 409, code: 'NOT_APPROVED', error: 'الطلب غير معتمَد — لا يُنفَّذ إلا بعد الاعتماد' };
  }
  if (request.appliedAt) {
    return { ok: false, status: 409, code: 'ALREADY_APPLIED', error: 'نُفِّذ هذا الطلب مسبقاً' };
  }
  return { ok: true };
}
