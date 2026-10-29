import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { closingStages, whereClosed } from './order-closing';
import { orderSearchOr } from './order-filters';
import { hasLeftWarehouse } from './order-state';
import { claimingRowWhere, integrityNotes, MANUAL_MATCH, openRequestWhere, type OtherStatement } from './match-integrity';
import { expectedAmountFor, judgeLine, SETTLEMENT_ORDER_SELECT } from './settlement';
import { isApproved } from './settlement-gates';

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
export const APPROVED_WHILE_LINKING_SENTENCE = 'الكشف انعتمد — حدّث';

export const OTHER_COURIER_WARNING = 'هذا الطلب مع شركة شحن أخرى غير صاحبة الكشف — اربطه فقط إن كنت متأكداً أن السطر له';

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
}

export interface CandidateSearch {
  header: string;
  counts: { total: number; closed: number; open: number };
  candidates: LinkCandidate[];
  /** Said when the search did not run (too short) or found nothing. */
  hint: string | null;
  /** The warning shown beside an order of another courier. */
  otherCourierWarning: string;
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
  p: { companyId: string; storeId: string; statementId: string; matchId: string; query: string; minorUnit: number }
): Promise<CandidateSearch> {
  const empty = (hint: string | null): CandidateSearch => ({
    header: candidatesHeader(0, 0),
    counts: { total: 0, closed: 0, open: 0 },
    candidates: [],
    hint,
    otherCourierWarning: OTHER_COURIER_WARNING,
  });

  const statement = await tx.courierStatement.findFirst({
    where: { id: p.statementId, companyId: p.companyId, storeId: p.storeId },
    select: { id: true, deliveryProviderId: true },
  });
  if (!statement) throw new LinkRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });

  const match = await tx.settlementMatch.findFirst({
    where: { id: p.matchId, statementId: p.statementId, companyId: p.companyId },
    select: { id: true, result: true, orderId: true, statementAmount: true },
  });
  if (!match) throw new LinkRefused(404, { error: 'سطر المطابقة غير موجود', code: 'NOT_FOUND' });
  if (match.result !== 'MISSING_IN_SYSTEM' || match.orderId) {
    throw new LinkRefused(409, { error: 'هذا السطر ليس من «في الكشف وليس عندنا»، أو رُبط بطلب من قبل', code: 'NOT_LINKABLE' });
  }

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
    select: { ...ORDER_FACTS, customer: { select: { id: true, fullName: true, phone: true } } },
    orderBy: { createdAt: 'desc' },
    take: CANDIDATE_READ,
  });
  if (rows.length === 0) return { ...empty('لا طلب بهذا البحث في متجر هذا الكشف'), header: candidatesHeader(total, closed), counts: { total, closed, open: Math.max(0, total - closed) } };

  const integrity = await integrityOf(tx, { companyId: p.companyId, statementId: p.statementId, orderIds: rows.map((r) => r.id) });

  const ranked = rankCandidates(
    rows.map((o): LinkCandidate & RankableCandidate => {
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
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        merchantRef: o.merchantRef,
        customer: o.customer,
        shippingStatus: o.shippingStatus,
        settlementStatus: o.settlementStatus,
        closed: closingStages({
          shippingStatus: o.shippingStatus,
          settlementStatus: o.settlementStatus,
          returnReceived: o.returnReceipt != null,
          confirmationStatus: o.confirmationStatus,
        }).closed,
        expected,
        distance: expected === null ? null : Math.abs(expected - lineAmount),
        otherCourier: o.deliveryProviderId !== statement.deliveryProviderId,
        blockedBy,
        linkable: blockedBy.length === 0,
      };
    })
  ).slice(0, CANDIDATE_LIMIT);

  return {
    header: candidatesHeader(total, closed),
    counts: { total, closed, open: Math.max(0, total - closed) },
    candidates: ranked.map(({ linkable: _linkable, ...c }) => c),
    hint: null,
    otherCourierWarning: OTHER_COURIER_WARNING,
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
    select: { id: true, status: true, approvedAt: true, reference: true, deliveryProviderId: true },
  });
  if (!statement) throw new LinkRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });
  // Linking decides which orders approval settles, exactly as matching does: after approval it is history.
  if (isApproved(statement)) {
    throw new LinkRefused(409, { error: 'الكشف معتمد — لا يُربط فيه سطر. أيّ تصحيح بعد الاعتماد يكون بقيد عكسي.', code: 'ALREADY_APPROVED' });
  }

  const match = await tx.settlementMatch.findFirst({
    where: { id: p.matchId, statementId: p.statementId, companyId: p.companyId },
    select: {
      id: true, result: true, orderId: true, statementLineId: true,
      statementLine: { select: { amount: true, fee: true, status: true } },
    },
  });
  if (!match) throw new LinkRefused(404, { error: 'سطر المطابقة غير موجود', code: 'NOT_FOUND' });
  if (match.result !== 'MISSING_IN_SYSTEM' || match.orderId || !match.statementLine) {
    throw new LinkRefused(409, { error: 'هذا السطر ليس من «في الكشف وليس عندنا»، أو رُبط بطلب من قبل', code: 'NOT_LINKABLE' });
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

  // The verdict is the matcher's own: same expectation, same fee rule, same reasons to look.
  const v = judgeLine({
    order,
    line: match.statementLine,
    minorUnit: p.minorUnit,
    integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: requests.map((r) => r.intent) },
  });

  // Claimed on the row's own state, so two people pressing at once cannot both link the one line.
  const claimed = await tx.settlementMatch.updateMany({
    // An open statement, and the row still unlinked: the write itself says so, not only the reads before it.
    where: { id: match.id, statementId: p.statementId, result: 'MISSING_IN_SYSTEM', orderId: null, statement: { approvedAt: null } },
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
    },
  });
  if (claimed.count !== 1) {
    const now = await tx.courierStatement.findFirst({
      where: { id: p.statementId, companyId: p.companyId },
      select: { status: true, approvedAt: true },
    });
    if (now && isApproved(now)) {
      throw new LinkRefused(409, { error: APPROVED_WHILE_LINKING_SENTENCE, code: 'ALREADY_APPROVED' });
    }
    throw new LinkRefused(409, { error: 'رُبط هذا السطر قبل لحظات', code: 'NOT_LINKABLE' });
  }

  // The order is now named by a line of this statement: it is no longer «a parcel no statement names» here.
  await tx.settlementMatch.deleteMany({
    where: { statementId: p.statementId, orderId: order.id, result: 'MISSING_IN_STATEMENT', resolution: null },
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
