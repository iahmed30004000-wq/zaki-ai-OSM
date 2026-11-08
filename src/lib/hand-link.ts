import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { closingStages, whereClosed } from './order-closing';
import { orderSearchOr } from './order-filters';
import { hasLeftWarehouse } from './order-state';
import { claimingRowWhere, integrityNotes, MANUAL_MATCH, openRequestWhere, type OtherStatement } from './match-integrity';
import { expectedAmountFor, judgeLine, SETTLEMENT_ORDER_SELECT } from './settlement';
import { closedStatementRefusal, isMatchingClosed } from './settlement-gates';
import { IN_FLIGHT, openClaimsFor } from './settlement-decisions';
import { lineEssentials, type LineEssentials, type LinePhone } from './statement-line-reading';
import { compareAmounts, compareGovernorates, comparePhones, type Agreement } from './line-compare';
import { SHIPPING_STATUS_AR } from './shipping-workflow';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * THE HAND LINK — «اربطه بطلب».
 *
 * A line the company wrote and the matcher could not tie to any order of ours (`MISSING_IN_SYSTEM`) used to be a
 * dead end: the reference was misspelled, or the company wrote the customer's phone, or its own number for the
 * parcel and nothing else. A person who can read the line can usually say which order it is — so this is the
 * door that lets them, and it is NOT the matcher:
 *
 *   · The phone never enters `runMatching`. It is searched HERE, by a person, who then looks at the candidates
 *     and picks one. A wrong automatic match moves money against the wrong order; a wrong pick is one a person
 *     made with the candidates in front of them.
 *   · Candidates come from the statement's own store and its own courier. An order of another courier is
 *     offered only when the person typed OUR order number, and it carries a warning.
 *   · It moves no money. It writes ONE match row — `matchedBy: MANUAL` — whose verdict is `judgeLine`'s, the
 *     function the matcher uses for every automatic line. Approval, receipts, «استلمت منه» and the calculator
 *     are exactly where they were.
 *   · A re-run of the matching keeps it (a MANUAL row is never deleted), and the «not mentioned by any
 *     statement» sweep counts it as mentioned.
 */

/** Fewer characters than this would list half the shop. */
export const MIN_QUERY = 3;
/** The most candidates one search returns, nearest to the line's amount first. */
export const CANDIDATE_LIMIT = 20;
/** Read before the nearest are picked, so a close amount is not cut off by the order of creation. */
const CANDIDATE_READ = 50;

export const OTHER_STORE_SENTENCE = 'هذا الطلب من متجر آخر — لا يُربط بكشف هذا المتجر';
export const NOT_SHIPPED_SENTENCE = 'هذا الطلب لم يخرج من المخزن — لا يُربط بسطر في كشف شركة الشحن';
/**
 * OUR number, exactly: the order number or the merchant reference, ignoring case. The ONE road to an order the
 * statement's courier does not carry — read by the search (as a query) and again by the link (in JS), so the
 * warning cannot be clicked through for an order the search would never have offered.
 */
export function isOurNumber(order: { orderNumber: string; merchantRef: string | null }, query: string | undefined | null): boolean {
  const q = (query ?? '').trim().toLowerCase();
  if (q.length === 0) return false;
  return order.orderNumber.toLowerCase() === q || (order.merchantRef ?? '').toLowerCase() === q;
}

export const OTHER_COURIER_NOT_EXACT_SENTENCE =
  'طلب شركة شحن أخرى يُربط برقم طلبنا بالضبط فقط — اكتب رقم الطلب كاملاً وابحث';

export const OTHER_COURIER_WARNING = 'هذا الطلب مع شركة شحن أخرى غير صاحبة الكشف — اربطه فقط إن كنت متأكداً أن السطر له';

/**
 * THE REFUSALS OF A PAGE THAT IS OLDER THAN THE LINE. Each says what happened and what to do — refresh — so a person
 * who pressed on a stale screen knows the line was not half-linked: the transaction wrote nothing.
 */
export const STALE_REFRESH = 'حدّث الصفحة لترى مكانه الآن';
export function alreadyLinkedSentence(orderNumber: string | null): string {
  return orderNumber
    ? `هذا السطر مربوط بالطلب ${orderNumber} من قبل — ما انربط مرة ثانية. ${STALE_REFRESH}`
    : `هذا السطر مربوط بطلب من قبل — ما انربط مرة ثانية. ${STALE_REFRESH}`;
}
export const STALE_LINE_MOVED_SENTENCE = `هذا السطر ما عاد بخانة «في الكشف وليس عندنا» — غالباً أُعيدت المطابقة بعد ما فتحت الصفحة. ${STALE_REFRESH}`;
export const STALE_LINE_GONE_SENTENCE = `سطر المطابقة هذا ما عاد موجوداً — أُعيدت المطابقة بعد ما فتحت الصفحة. ${STALE_REFRESH}`;
export const JUST_LINKED_SENTENCE = `رُبط هذا السطر قبل لحظات من شخص آخر — ما انكتب شي. ${STALE_REFRESH}`;

/** A stop that carries its own answer: the transaction rolls back and the route sends this. */
export class LinkRefused extends Error {
  constructor(readonly status: number, readonly body: { error: string; code: string; reasons?: string[] }) {
    super(body.code);
  }
}

/**
 * «لهذا الرقم 4 طلبات: 1 مغلق، 3 مفتوحة» — read off the counts, never off the page, so the header is true even
 * when the list shows only the nearest few.
 */
export function candidatesHeader(total: number, closed: number): string {
  if (total <= 0) return 'لا طلبات لهذا البحث';
  const open = Math.max(0, total - closed);
  if (total === 1) return `لهذا الرقم طلب واحد: ${closed === 1 ? 'مغلق' : 'مفتوح'}`;
  return `لهذا الرقم ${total} طلبات: ${closed} مغلق، ${open} مفتوحة`;
}

export interface RankableCandidate {
  /** Null when the order's expectation could not be read: it sorts last. */
  distance: number | null;
  /** A candidate a person may pick sorts before one the rules would refuse. */
  linkable: boolean;
  orderNumber: string;
}

/** Orders a person may pick first, then by how near their expected amount is to the line's. */
export function rankCandidates<T extends RankableCandidate>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.linkable !== b.linkable) return a.linkable ? -1 : 1;
    const da = a.distance ?? Number.POSITIVE_INFINITY;
    const dbb = b.distance ?? Number.POSITIVE_INFINITY;
    if (da !== dbb) return da - dbb;
    return a.orderNumber.localeCompare(b.orderNumber);
  });
}

/** The reasons an order may not be tied to a line of THIS statement, in the words the matcher writes beside a row. */
export function linkBlockers(facts: {
  settlementStatus: string | null | undefined;
  claimedInThisStatement: boolean;
  otherStatements: OtherStatement[];
}): string[] {
  return integrityNotes({
    settlementStatus: facts.settlementStatus,
    claimedByAnotherLine: facts.claimedInThisStatement,
    otherStatements: facts.otherStatements,
    // An open cancel or postpone request does not forbid the link: it is the verdict's to flag, as for any line.
    openRequests: [],
  });
}

interface IntegrityByOrder {
  claimedHere: Set<string>;
  elsewhere: Map<string, OtherStatement[]>;
}

/** Which of these orders a row of this statement already holds, and which other statements hold them. */
async function integrityOf(tx: Tx, p: { companyId: string; statementId: string; orderIds: string[] }): Promise<IntegrityByOrder> {
  const claimedHere = new Set<string>();
  const elsewhere = new Map<string, OtherStatement[]>();
  if (p.orderIds.length === 0) return { claimedHere, elsewhere };

  const here = await tx.settlementMatch.findMany({
    where: { companyId: p.companyId, statementId: p.statementId, orderId: { in: p.orderIds }, OR: claimingRowWhere() },
    select: { orderId: true },
  });
  for (const r of here) if (r.orderId) claimedHere.add(r.orderId);

  const others = await tx.settlementMatch.findMany({
    where: {
      companyId: p.companyId,
      orderId: { in: p.orderIds },
      statementId: { not: p.statementId },
      statementLineId: { not: null },
      OR: claimingRowWhere(),
    },
    select: { orderId: true, statement: { select: { reference: true, approvedAt: true } } },
  });
  for (const o of others) {
    if (!o.orderId) continue;
    elsewhere.set(o.orderId, [
      ...(elsewhere.get(o.orderId) ?? []),
      { reference: o.statement.reference, approved: o.statement.approvedAt != null },
    ]);
  }
  return { claimedHere, elsewhere };
}

const ORDER_FACTS = {
  id: true,
  orderNumber: true,
  merchantRef: true,
  storeId: true,
  deliveryProviderId: true,
  settlementStatus: true,
  confirmationStatus: true,
  shippedAt: true,
  labelPrintedAt: true,
  createdAt: true,
  ...SETTLEMENT_ORDER_SELECT,
} as const;

/**
 * What the company's line is read from: the figures it parsed, the status word, the raw row, and the five cells the import
 * kept under the company's own headings (`StatementLine.receiver*`). One select for both searches, so the dialog's card
 * of «ما كتبته الشركة» is the same whichever way the person searched.
 */
const LINE_SELECT = {
  rawRow: true, merchantRef: true, barcode: true, amount: true, collected: true, fee: true, status: true,
  receiverName: true, receiverPhone: true, receiverAddress: true, receiverCity: true, receiverArea: true,
} as const;

const CANDIDATE_SELECT = {
  ...ORDER_FACTS,
  // The parcel's own address wins over the customer's, as the dispatch reads them (`couriers/dispatch.ts`).
  deliveryAddress: true,
  region: { select: { name: true } },
  customer: { select: { id: true, fullName: true, phone: true, rawPhone: true, address: true, city: true } },
} as const;
type CandidateRow = Prisma.OrderGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/**
 * WHAT OUR ORDER SAYS, field by field — to be held against what the company wrote (`LineSummary`). Display only: a person
 * reads it, the server's own rules still judge the link. The figures are the order's own, never computed here.
 */
export interface CandidateDetails {
  name: string | null;
  /** As the customer typed it, else the stored form. */
  phone: string | null;
  /** The parcel's own address, else the customer's. */
  address: string | null;
  /** The delivery region of the order (a row of the fee table): its governorate. */
  governorate: string | null;
  /** Our own word for where the parcel is: «مشحون»، «خرج للتوصيل»… */
  shipping: string;
  /** What the order asks the customer to pay at the door, and the delivery fee inside it. */
  totalAmount: number;
  deliveryFee: number | null;
}

export interface LinkCandidate {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  customer: { id: string; fullName: string; phone: string } | null;
  shippingStatus: string;
  settlementStatus: string;
  /** Both stages of the order are finished (`closingStages`). */
  closed: boolean;
  /** What the courier owes for it, by the one rule. */
  expected: number | null;
  /** How far that is from the line's amount (absolute). */
  distance: number | null;
  /** The order is with another courier than the statement's. */
  otherCourier: boolean;
  /** Why the rules would refuse it, in Arabic. Empty means a person may pick it. */
  blockedBy: string[];
  /** What the order says about itself, beside what the company wrote about the line. */
  details: CandidateDetails;
  /** Where the order and the line agree, for the three fields that can be compared without guessing. */
  compare: { phone: Agreement; governorate: Agreement; amount: Agreement };
}

/** What the company wrote on the line — the card at the top of the dialog. Every piece is the company's own, or null. */
export interface LineSummary {
  /** The company's own status word. */
  status: string | null;
  name: string | null;
  /** The phone as read off the line (`shown`), or null when the line carries none. */
  phone: string | null;
  governorate: string | null;
  address: string | null;
  /** The company's figures for the line, as it stated them: the net it hands over, what it collected, the fee it kept. */
  net: number | null;
  collected: number | null;
  fee: number | null;
}

export interface CandidateSearch {
  header: string;
  counts: { total: number; closed: number; open: number };
  candidates: LinkCandidate[];
  /** Said when the search did not run (too short) or found nothing. */
  hint: string | null;
  /** The warning shown beside an order of another courier. */
  otherCourierWarning: string;
  /** What the company wrote on the line being tied, so the person can hold each order against it. Absent on an old answer. */
  line?: LineSummary | null;
}

/** The figures of a line as a database row or a mock carries them (decimals or strings or numbers): read through `numberOrNull`. */
type LineRow = { amount?: unknown; collected?: unknown; fee?: unknown };

const numberOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** The card of the company's line, from the row the select read. */
function summarizeLine(row: LineRow | null | undefined, essentials: LineEssentials | null): LineSummary | null {
  if (!row || !essentials) return null;
  return {
    status: essentials.status,
    name: essentials.name,
    phone: essentials.phone?.shown ?? null,
    governorate: essentials.governorate,
    address: essentials.address,
    net: numberOrNull(row.amount),
    collected: numberOrNull(row.collected),
    fee: numberOrNull(row.fee),
  };
}

/**
 * THE CANDIDATES FOR ONE LINE, from what the person typed — a phone, our order number, the company's barcode.
 *
 * Scope is fixed here and never taken from the request: this company, this STATEMENT'S store, this statement's
 * courier. The one widening is an exact hit on our own order number or merchant reference, which may belong to
 * another courier (the order changed hands after we sent it) and says so.
 */
export async function findLinkCandidates(
  tx: Tx,
  p: {
    companyId: string; storeId: string; statementId: string; matchId: string; query: string; minorUnit: number;
    /** The store's country, so the line's phone is read the way this store's customers are stored. */
    countryCode?: string | null;
  }
): Promise<CandidateSearch> {
  const statement = await tx.courierStatement.findFirst({
    where: { id: p.statementId, companyId: p.companyId, storeId: p.storeId },
    select: { id: true, deliveryProviderId: true },
  });
  if (!statement) throw new LinkRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });

  const match = await tx.settlementMatch.findFirst({
    where: { id: p.matchId, statementId: p.statementId, companyId: p.companyId },
    select: { id: true, result: true, orderId: true, statementAmount: true, statementLine: { select: LINE_SELECT } },
  });
  if (!match) throw new LinkRefused(404, { error: 'سطر المطابقة غير موجود', code: 'NOT_FOUND' });
  if (match.result !== 'MISSING_IN_SYSTEM' || match.orderId) {
    throw new LinkRefused(409, { error: 'هذا السطر ليس من «في الكشف وليس عندنا»، أو رُبط بطلب من قبل', code: 'NOT_LINKABLE' });
  }

  // What the company wrote on this line: shown at the top of the dialog whichever way the person searched, and what each
  // candidate is held against (the phone, the governorate).
  const essentials = match.statementLine ? lineEssentials(match.statementLine, p.countryCode) : null;
  const line = summarizeLine(match.statementLine, essentials);
  const empty = (hint: string | null): CandidateSearch => ({
    header: candidatesHeader(0, 0),
    counts: { total: 0, closed: 0, open: 0 },
    candidates: [],
    hint,
    otherCourierWarning: OTHER_COURIER_WARNING,
    line,
  });

  const query = p.query.trim();
  if (query.length < MIN_QUERY) return empty(`اكتب ${MIN_QUERY} خانات على الأقل: هاتف الزبون، أو رقم طلبنا، أو رقم الشحنة`);

  const lineAmount = Number(match.statementAmount ?? 0);
  const search = orderSearchOr(query);
  const mine = { companyId: p.companyId, storeId: p.storeId, deliveryProviderId: statement.deliveryProviderId };

  // The header is counted by the database, with the one «closed» rule, so it is true however many rows follow.
  const [total, closed] = await Promise.all([
    tx.order.count({ where: { ...mine, OR: search } as Prisma.OrderWhereInput }),
    tx.order.count({ where: { ...mine, AND: [{ OR: search }, whereClosed()] } as Prisma.OrderWhereInput }),
  ]);

  const rows = await tx.order.findMany({
    where: {
      OR: [
        { ...mine, OR: search },
        // OUR number, exactly: the one road to an order the statement's courier does not carry.
        {
          companyId: p.companyId,
          storeId: p.storeId,
          OR: [
            { orderNumber: { equals: query, mode: 'insensitive' } },
            { merchantRef: { equals: query, mode: 'insensitive' } },
          ],
        },
      ],
    } as Prisma.OrderWhereInput,
    select: CANDIDATE_SELECT,
    orderBy: { createdAt: 'desc' },
    take: CANDIDATE_READ,
  });
  if (rows.length === 0) return { ...empty('لا طلب بهذا البحث في متجر هذا الكشف'), header: candidatesHeader(total, closed), counts: { total, closed, open: Math.max(0, total - closed) } };

  return {
    header: candidatesHeader(total, closed),
    counts: { total, closed, open: Math.max(0, total - closed) },
    candidates: await candidatesOf(tx, {
      companyId: p.companyId, statementId: p.statementId, deliveryProviderId: statement.deliveryProviderId,
      minorUnit: p.minorUnit, lineAmount, rows,
      lineFacts: { phoneKeys: essentials?.phone?.keys ?? null, city: essentials?.city ?? null }, storeCountry: p.countryCode,
    }),
    hint: null,
    otherCourierWarning: OTHER_COURIER_WARNING,
    line,
  };
}

/**
 * The rows a search read, as candidates: each with what the courier owes for it, how near that is to the line, and
 * why the rules would refuse it — the nearest a person may pick first. One builder for both searches, so the phone
 * search cannot offer an order the text search would have greyed out.
 */
async function candidatesOf(
  tx: Tx,
  p: {
    companyId: string; statementId: string; deliveryProviderId: string | null; minorUnit: number; lineAmount: number; rows: CandidateRow[];
    /** What the line says that an order can be compared with: the keys of its phone and its governorate. Absent: nothing to compare. */
    lineFacts?: { phoneKeys: string[] | null; city: string | null };
    storeCountry?: string | null;
  }
): Promise<LinkCandidate[]> {
  const integrity = await integrityOf(tx, { companyId: p.companyId, statementId: p.statementId, orderIds: p.rows.map((r) => r.id) });

  const ranked = rankCandidates(
    p.rows.map((o): LinkCandidate & RankableCandidate => {
      let expected: number | null = null;
      try {
        expected = expectedAmountFor(o, p.minorUnit);
      } catch {
        expected = null;
      }
      const blockedBy = linkBlockers({
        settlementStatus: o.settlementStatus,
        claimedInThisStatement: integrity.claimedHere.has(o.id),
        otherStatements: integrity.elsewhere.get(o.id) ?? [],
      });
      if (!hasLeftWarehouse(o)) blockedBy.unshift(NOT_SHIPPED_SENTENCE);
      const distance = expected === null ? null : Math.abs(expected - p.lineAmount);
      const governorate = o.region?.name?.trim() || null;
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        merchantRef: o.merchantRef,
        // Exactly the three fields it always carried: the people-handed-out tally reads this, and the rest of what the
        // customer row holds goes into `details` below.
        customer: o.customer ? { id: o.customer.id, fullName: o.customer.fullName, phone: o.customer.phone } : null,
        shippingStatus: o.shippingStatus,
        settlementStatus: o.settlementStatus,
        closed: closingStages({
          shippingStatus: o.shippingStatus,
          settlementStatus: o.settlementStatus,
          returnReceived: o.returnReceipt != null,
          confirmationStatus: o.confirmationStatus,
        }).closed,
        expected,
        distance,
        otherCourier: o.deliveryProviderId !== p.deliveryProviderId,
        blockedBy,
        details: {
          name: o.customer?.fullName?.trim() || null,
          phone: o.customer?.rawPhone?.trim() || o.customer?.phone?.trim() || null,
          address: o.deliveryAddress?.trim() || o.customer?.address?.trim() || null,
          governorate,
          shipping: (SHIPPING_STATUS_AR as Record<string, string>)[o.shippingStatus] ?? o.shippingStatus,
          totalAmount: Number(o.totalAmount),
          deliveryFee: o.deliveryFee === null || o.deliveryFee === undefined ? null : Number(o.deliveryFee),
        },
        compare: {
          phone: comparePhones(p.lineFacts?.phoneKeys, o.customer, p.storeCountry),
          governorate: compareGovernorates(p.lineFacts?.city, governorate),
          amount: compareAmounts(distance, p.minorUnit),
        },
        linkable: blockedBy.length === 0,
      };
    })
  ).slice(0, CANDIDATE_LIMIT);

  return ranked.map(({ linkable: _linkable, ...c }) => c);
}

/** «بهاتف السطر»: what the search says about the phone it used, so the screen can show it and where it came from. */
export interface LinePhoneSearch extends CandidateSearch {
  /** The phone read off the line, or null when the line carries none. */
  phone: Pick<LinePhone, 'shown' | 'country'> | null;
}

export const NO_LINE_PHONE_SENTENCE = 'ما في رقم هاتف بسطر الشركة — اكتب الهاتف أو رقم الطلب بالبحث تحت';
export const NO_IN_FLIGHT_SENTENCE = 'لهذا الرقم ولا طلب قيد الشحن مع شركة هذا الكشف — جرّب البحث الحر برقم الطلب';

/** «لهذا الرقم 2 طلبات قيد الشحن» — counted by the database, so it is true however many rows the list shows. */
export function inFlightHeader(total: number): string {
  if (total <= 0) return 'لا طلبات قيد الشحن لهذا الرقم';
  if (total === 1) return 'لهذا الرقم طلب واحد قيد الشحن';
  return `لهذا الرقم ${total} طلبات قيد الشحن`;
}

/**
 * «بهاتف السطر» — THE ORDERS OF THE PHONE THE COMPANY WROTE, STILL ON THE ROAD.
 *
 * The owner's words: take the phone of that very line by itself, show the orders still being shipped, and let me
 * pick. So the phone is never taken from the request: it is read off the line itself (`lineEssentials`: the column the
 * company headed as the receiver's phone, else its raw row) and may be a number of any country. A line that may be
 * linked has no order (that is what makes it linkable), so there is no order's phone to read first.
 *
 * Scope is the text search's, unwidened: this company, this statement's store, this statement's courier — and only
 * orders still in flight (`IN_FLIGHT`: shipped, out for delivery, ready for pickup, failed delivery). A delivered,
 * returned or cancelled order is not offered. The candidates are built and greyed by the same builder, and the link
 * that follows is the same `linkLineToOrder`, judged by `judgeLine`.
 */
export async function findLinkCandidatesByLinePhone(
  tx: Tx,
  p: { companyId: string; storeId: string; statementId: string; matchId: string; minorUnit: number; countryCode?: string | null }
): Promise<LinePhoneSearch> {
  const statement = await tx.courierStatement.findFirst({
    where: { id: p.statementId, companyId: p.companyId, storeId: p.storeId },
    select: { id: true, deliveryProviderId: true },
  });
  if (!statement) throw new LinkRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });

  const match = await tx.settlementMatch.findFirst({
    where: { id: p.matchId, statementId: p.statementId, companyId: p.companyId },
    select: { id: true, result: true, orderId: true, statementAmount: true, statementLine: { select: LINE_SELECT } },
  });
  if (!match) throw new LinkRefused(404, { error: 'سطر المطابقة غير موجود', code: 'NOT_FOUND' });
  if (match.result !== 'MISSING_IN_SYSTEM' || match.orderId) {
    throw new LinkRefused(409, { error: 'هذا السطر ليس من «في الكشف وليس عندنا»، أو رُبط بطلب من قبل', code: 'NOT_LINKABLE' });
  }

  // The phone of the company's line: the column it headed «هاتف المستلم» when the file was imported; for a line imported
  // before that was kept, the first mobile (or number written with + / 00) in its raw row. Either way a number of any
  // country — a foreign line is a phone too (`lineEssentials`).
  const essentials = match.statementLine ? lineEssentials(match.statementLine, p.countryCode) : null;
  const line = summarizeLine(match.statementLine, essentials);
  const base = { candidates: [] as LinkCandidate[], otherCourierWarning: OTHER_COURIER_WARNING, line };
  const phone = essentials?.phone ?? null;
  if (!phone) {
    return { ...base, header: inFlightHeader(0), counts: { total: 0, closed: 0, open: 0 }, hint: NO_LINE_PHONE_SENTENCE, phone: null };
  }

  const where = {
    companyId: p.companyId,
    storeId: p.storeId,
    deliveryProviderId: statement.deliveryProviderId,
    shippingStatus: { in: [...IN_FLIGHT] },
    customer: { phone: { in: phone.keys } },
  } as Prisma.OrderWhereInput;

  const [total, rows] = await Promise.all([
    tx.order.count({ where }),
    tx.order.findMany({ where, select: CANDIDATE_SELECT, orderBy: { createdAt: 'desc' }, take: CANDIDATE_READ }),
  ]);
  const shown = { shown: phone.shown, country: phone.country };
  if (rows.length === 0) {
    return { ...base, header: inFlightHeader(total), counts: { total, closed: 0, open: total }, hint: NO_IN_FLIGHT_SENTENCE, phone: shown };
  }

  return {
    ...base,
    header: inFlightHeader(total),
    // In flight is open by definition: nothing here has finished both its stages.
    counts: { total, closed: 0, open: total },
    candidates: await candidatesOf(tx, {
      companyId: p.companyId, statementId: p.statementId, deliveryProviderId: statement.deliveryProviderId,
      minorUnit: p.minorUnit, lineAmount: Number(match.statementAmount ?? 0), rows,
      lineFacts: { phoneKeys: phone.keys, city: essentials?.city ?? null }, storeCountry: p.countryCode,
    }),
    hint: null,
    phone: shown,
  };
}

export interface LinkResult {
  matchId: string;
  orderId: string;
  orderNumber: string;
  result: 'MATCHED' | 'MISMATCHED';
  note: string | null;
  expected: number;
  stated: number;
  difference: number;
  otherCourier: boolean;
  reference: string;
}

/**
 * TIE THE LINE TO THE ORDER — inside the caller's transaction.
 *
 * Refuses, in this order: an approved statement, a row that is not an unlinked «في الكشف وليس عندنا», an order of
 * another store, an order that never left the warehouse, an order of another courier the person was not warned
 * about, and an order the rules reserve elsewhere (settled, already matched here, named by another statement).
 * What is left is judged by `judgeLine` — MATCHED when the figures agree and nothing else forbids it, otherwise
 * MISMATCHED with the reason beside it — and written onto the SAME row, so the line has one answer, not two.
 */
export async function linkLineToOrder(
  tx: Tx,
  p: {
    companyId: string;
    storeId: string;
    statementId: string;
    matchId: string;
    orderId: string;
    userId: string;
    minorUnit: number;
    /** The person saw the other-courier warning and went on. */
    acceptOtherCourier: boolean;
    /** What the person typed to find the order: another courier's order must be OUR number, exactly. */
    query?: string;
  }
): Promise<LinkResult> {
  // The statement's row is locked before anything is read, so an approval cannot slip in between the check
  // that it is open and the write: it either finished first (and is refused below) or waits for this to commit
  // (and then reads the link). The same lock the approval's own claim takes.
  await tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${p.statementId} FOR UPDATE`;
  const statement = await tx.courierStatement.findFirst({
    where: { id: p.statementId, companyId: p.companyId, storeId: p.storeId },
    select: { id: true, status: true, approvedAt: true, matchingClosedAt: true, reference: true, deliveryProviderId: true },
  });
  if (!statement) throw new LinkRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });
  // Linking decides which orders approval settles, exactly as matching does: after approval it is history.
  if (isMatchingClosed(statement)) {
    throw new LinkRefused(409, closedStatementRefusal());
  }

  const match = await tx.settlementMatch.findFirst({
    where: { id: p.matchId, statementId: p.statementId, companyId: p.companyId },
    select: {
      id: true, result: true, orderId: true, statementLineId: true,
      statementLine: { select: { amount: true, fee: true, status: true } },
    },
  });
  if (!match) throw new LinkRefused(404, { error: STALE_LINE_GONE_SENTENCE, code: 'NOT_FOUND' });
  if (match.orderId) {
    // Somebody tied it first (or the page is older than the link): say to which order, so nobody links it twice.
    const held = await tx.order.findFirst({ where: { id: match.orderId, companyId: p.companyId }, select: { orderNumber: true } });
    throw new LinkRefused(409, { error: alreadyLinkedSentence(held?.orderNumber ?? null), code: 'NOT_LINKABLE' });
  }
  if (match.result !== 'MISSING_IN_SYSTEM' || !match.statementLine) {
    throw new LinkRefused(409, { error: STALE_LINE_MOVED_SENTENCE, code: 'NOT_LINKABLE' });
  }

  // The order's row too: a hand collection claims it, and between its check and its claim this cannot slip a
  // link in — whichever takes the row second sees what the first did.
  await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${p.orderId} FOR UPDATE`;
  const order = await tx.order.findFirst({
    where: { id: p.orderId, companyId: p.companyId },
    select: ORDER_FACTS,
  });
  if (!order) throw new LinkRefused(404, { error: 'الطلب غير موجود', code: 'ORDER_NOT_FOUND' });
  if (order.storeId !== p.storeId) throw new LinkRefused(409, { error: OTHER_STORE_SENTENCE, code: 'OTHER_STORE' });
  if (!hasLeftWarehouse(order)) throw new LinkRefused(409, { error: NOT_SHIPPED_SENTENCE, code: 'NOT_SHIPPED' });

  const otherCourier = order.deliveryProviderId !== statement.deliveryProviderId;
  if (otherCourier && !isOurNumber(order, p.query)) {
    // The warning cannot be clicked through for an order the search would not have offered.
    throw new LinkRefused(409, { error: OTHER_COURIER_NOT_EXACT_SENTENCE, code: 'OTHER_COURIER_NOT_EXACT' });
  }
  if (otherCourier && !p.acceptOtherCourier) {
    throw new LinkRefused(409, { error: OTHER_COURIER_WARNING, code: 'OTHER_COURIER' });
  }

  const integrity = await integrityOf(tx, { companyId: p.companyId, statementId: p.statementId, orderIds: [order.id] });
  const otherStatements = integrity.elsewhere.get(order.id) ?? [];
  const reasons = linkBlockers({
    settlementStatus: order.settlementStatus,
    claimedInThisStatement: integrity.claimedHere.has(order.id),
    otherStatements,
  });
  if (reasons.length > 0) {
    throw new LinkRefused(409, { error: `لا يُربط هذا الطلب: ${reasons.join(' · ')}`, code: 'ORDER_NOT_LINKABLE', reasons });
  }

  const requests = await tx.orderChangeRequest.findMany({
    where: { companyId: p.companyId, orderId: order.id, ...openRequestWhere() },
    select: { intent: true },
  });

  // What the company still owes on this order, when an earlier approved statement was answered «رقمنا»: the matcher
  // judges the line against it, and so does a person's link — one rule for both.
  const claims =
    order.settlementStatus === 'SETTLED'
      ? new Map<string, { remaining: number }>()
      : await openClaimsFor(tx, { companyId: p.companyId, orderIds: [order.id], excludeStatementId: p.statementId, minorUnit: p.minorUnit });

  // The verdict is the matcher's own: same expectation, same fee rule, same reasons to look.
  const v = judgeLine({
    order,
    line: match.statementLine,
    minorUnit: p.minorUnit,
    integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: requests.map((r) => r.intent) },
    openClaim: claims.get(order.id)?.remaining ?? null,
  });

  // Claimed on the row's own state, so two people pressing at once cannot both link the one line.
  const claimed = await tx.settlementMatch.updateMany({
    // An open statement, and the row still unlinked: the write itself says so, not only the reads before it.
    where: { id: match.id, statementId: p.statementId, result: 'MISSING_IN_SYSTEM', orderId: null, statement: { matchingClosedAt: null } },
    data: {
      orderId: order.id,
      result: v.result,
      matchedBy: MANUAL_MATCH,
      expectedAmount: v.expected,
      statementAmount: v.stated,
      difference: v.difference,
      expectedFee: v.expectedFee,
      statementFee: v.statedFee,
      feeDifference: v.feeDifference,
      note: v.note,
      // A line that was parked («قيد المراجعة», the one answer a line with no order may have) is a line with an order now,
      // judged afresh: the old answer does not follow it, or a difference would look answered when nobody has.
      resolution: null,
      resolutionNote: null,
      resolvedById: null,
      resolvedAt: null,
    },
  });
  if (claimed.count !== 1) {
    const now = await tx.courierStatement.findFirst({
      where: { id: p.statementId, companyId: p.companyId },
      select: { status: true, approvedAt: true, matchingClosedAt: true },
    });
    if (now && isMatchingClosed(now)) {
      throw new LinkRefused(409, closedStatementRefusal());
    }
    throw new LinkRefused(409, { error: JUST_LINKED_SENTENCE, code: 'NOT_LINKABLE' });
  }

  // The order is now named by a line of this statement: it is no longer «a parcel no statement names» here.
  await tx.settlementMatch.deleteMany({
    where: { statementId: p.statementId, orderId: order.id, result: 'MISSING_IN_STATEMENT', resolution: null, statement: { matchingClosedAt: null } },
  });

  await tx.orderNote.create({
    data: {
      companyId: p.companyId,
      orderId: order.id,
      authorId: p.userId,
      kind: 'internal',
      body: `رُبط يدوياً بسطر من كشف ${statement.reference}${v.clean ? '' : ` — يحتاج نظرة: ${v.note ?? ''}`}`,
    },
  });

  return {
    matchId: match.id,
    orderId: order.id,
    orderNumber: order.orderNumber,
    result: v.result,
    note: v.note,
    expected: v.expected,
    stated: v.stated,
    difference: v.difference,
    otherCourier,
    reference: statement.reference,
  };
}
