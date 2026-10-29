import crypto from 'node:crypto';

/**
 * THE MANUAL STATEMENT — the rules that need no database.
 *
 * A company that sends no statement (or whose statement never arrived) is settled by a person gathering the
 * parcels its courier handed over into ONE statement and approving it. The statement is an ordinary
 * `CourierStatement`, and what makes it a manual one is nothing but its `fileHash`:
 *
 *   'manual:draft:' + uuid               open: orders are still being added; no reference, no receipt yet
 *   'manual:' + sha256(company, courier, reference)
 *                                         gathered: the reference is unique PER COMPANY AND COURIER, so two
 *                                         couriers may both have «كشف الأحد» and not collide
 *
 * Everything else about it is the existing statement: the receipt (with its wallet and rate), the matching,
 * the approval. This file only says which statement is manual, which orders may enter one, and in what words
 * a refusal is made. It reads nothing and writes nothing — the door that does is `manual-statement.ts`.
 */

export const MANUAL_PREFIX = 'manual:';
export const MANUAL_DRAFT_PREFIX = 'manual:draft:';

/** What a draft is called until it is gathered: it has no reference of its own yet. */
export const DRAFT_REFERENCE = 'مسوّدة كشف يدوي';
/** The file name column is required; a manual statement has no file, so it says what it is instead. */
export const MANUAL_FILE_NAME = 'كشف يدوي';

/** Is this statement one a person gathered by hand (a draft or a gathered one)? */
export function isManualHash(hash: string | null | undefined): boolean {
  return typeof hash === 'string' && hash.startsWith(MANUAL_PREFIX);
}

/** Is it still the open draft, where orders can be added? */
export function isManualDraftHash(hash: string | null | undefined): boolean {
  return typeof hash === 'string' && hash.startsWith(MANUAL_DRAFT_PREFIX);
}

export function newDraftHash(): string {
  return `${MANUAL_DRAFT_PREFIX}${crypto.randomUUID()}`;
}

/** The reference as it is compared: trimmed, inner spaces collapsed, Latin letters in one case. */
export function normalizeReference(reference: string): string {
  return reference.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * THE HASH OF A GATHERED STATEMENT — (company, courier, reference), never the reference alone.
 *
 * The column is unique per company, so a hash of the reference alone would refuse the second courier's
 * «كشف الأحد». The three parts are encoded as a JSON array so no choice of reference can read as another
 * courier's id. It starts with `manual:` and a hex digest cannot start with `draft:`, so a gathered
 * statement is never mistaken for a draft.
 */
export function manualFileHash(p: { companyId: string; courierId: string; reference: string }): string {
  const body = JSON.stringify([p.companyId, p.courierId, normalizeReference(p.reference)]);
  return `${MANUAL_PREFIX}${crypto.createHash('sha256').update(body).digest('hex')}`;
}

/** An order as the manual door judges it. */
export interface ManualOrderFacts {
  orderNumber: string;
  merchantRef: string | null;
  currency: string;
  shippingStatus: string;
  settlementStatus: string | null;
  deliveryProviderId: string | null;
}

export interface ManualRefusalBody {
  code: string;
  error: string;
  orders?: string[];
}

const DELIVERED = ['DELIVERED', 'PARTIALLY_DELIVERED'];

const names = (orders: ManualOrderFacts[]) => orders.map((o) => o.orderNumber).join('، ');

export const MIXED_COURIERS_SENTENCE = 'الكشف اليدوي لجهة شحن واحدة في كل مرة — اختر طلبات جهة واحدة';
export const HAS_RECEIPT_SENTENCE = 'سُجِّل لهذا الكشف إيصال — لا تُضاف إليه طلبات بعد أول إيصال';
/** What a receipt, a matching or an approval answers while the statement is still an open draft. */
export const MANUAL_DRAFT_SENTENCE = 'هذه مسوّدة كشف يدوي — اضغط «تجميع» وأعطها مرجعاً أولاً، ثم سجّل الإيصال';

/**
 * MAY THESE ORDERS ENTER A MANUAL STATEMENT? The first thing wrong is the answer; null means they may.
 *
 * The order of the questions is the order a person can act on them:
 *   · an order with no courier is named — a statement is a courier's, and choosing one for a delivered order
 *     would be a new door (the owner uses «استلمت منه» for it);
 *   · more than one courier — the money of one is never put in another's statement;
 *   · an order not delivered, or already settled — nothing is owed on it, or it was paid already;
 *   · a currency other than the statement's — the lines of a statement are in one currency;
 *   · an order with no reference — the line is tied to the order by it, and nothing else.
 */
export function manualAddRefusal(orders: ManualOrderFacts[], statementCurrency: string): ManualRefusalBody | null {
  const withoutCourier = orders.filter((o) => !o.deliveryProviderId);
  if (withoutCourier.length > 0) {
    return {
      code: 'NO_COURIER',
      error: `طلبات بلا شركة شحن: ${names(withoutCourier)} — الكشف اليدوي لجهة معيّنة. للنقد استعمل «استلمت منه».`,
      orders: withoutCourier.map((o) => o.orderNumber),
    };
  }
  if (new Set(orders.map((o) => o.deliveryProviderId)).size > 1) {
    return { code: 'MIXED_COURIERS', error: MIXED_COURIERS_SENTENCE };
  }
  const notDelivered = orders.filter((o) => !DELIVERED.includes(o.shippingStatus));
  if (notDelivered.length > 0) {
    return {
      code: 'NOT_DELIVERED',
      error: `طلبات غير مسلَّمة: ${names(notDelivered)}`,
      orders: notDelivered.map((o) => o.orderNumber),
    };
  }
  const settled = orders.filter((o) => o.settlementStatus === 'SETTLED');
  if (settled.length > 0) {
    return {
      code: 'ALREADY_SETTLED',
      error: `طلبات مسوّاة مسبقاً: ${names(settled)}`,
      orders: settled.map((o) => o.orderNumber),
    };
  }
  const otherCurrency = orders.filter((o) => o.currency !== statementCurrency);
  if (otherCurrency.length > 0) {
    return {
      code: 'CURRENCY_MISMATCH',
      error: `طلبات بعملة غير عملة الكشف (${statementCurrency}): ${names(otherCurrency)}`,
      orders: otherCurrency.map((o) => o.orderNumber),
    };
  }
  const noReference = orders.filter((o) => !o.merchantRef);
  if (noReference.length > 0) {
    return {
      code: 'NO_REFERENCE',
      error: `طلبات بلا مرجع يربطها بالكشف: ${names(noReference)}`,
      orders: noReference.map((o) => o.orderNumber),
    };
  }
  return null;
}

/** The sentence when a reference is already another manual statement of the same courier. */
export function duplicateReferenceSentence(reference: string): string {
  return `المرجع «${reference.trim()}» مستعمل لهذه الشركة في كشف يدوي آخر — اختر مرجعاً مختلفاً`;
}
