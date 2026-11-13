import type { Prisma, PrismaClient } from '@prisma/client';
import { orderSearchOr } from './order-filters';
import { normalizePhoneNumber } from './phone';
import { typed } from './text-search';
import { isManualDraftHash } from './manual-statement-rules';
import { isApproved, isMatchingClosed } from './settlement-gates';
import { EXCHANGE_AR, PARKED, PARKED_AR, RESOLUTION_AR, isExchange } from './settlement-difference';
import {
  MAX_HITS,
  NOT_MATCHED_YET_AR,
  RESULT_AR,
  isQueue,
  type HitStatement,
  type StatementHit,
  type StatementSearchResponse,
} from './statement-search-rules';

/**
 * «اعمل زر بحث داخل كل الكشوف» (the owner, 13/11) — WHERE DID THIS PARCEL APPEAR, IN ANY STATEMENT OF THE STORE?
 *
 * The matching screen's box narrows the queues of the statement that is open. This asks every statement at once, by what a
 * person has in hand — our order number, the courier's barcode, the company's own reference, and (only for somebody who may
 * read customers' numbers) the customer's name or phone — and answers with the LINES that mention it: which statement wrote
 * each, what the matching made of it, what was answered, and the figures.
 *
 * ── TWO KINDS OF ROW, BECAUSE A STATEMENT MENTIONS A PARCEL IN TWO WAYS ──
 *
 *   · a LINE the company wrote. It is found by its own barcode or reference (or the receiver's name / phone, for who may),
 *     or because the order the matching tied it to is the one searched for. It is read from `StatementLine`, not from the
 *     matching's rows, so a statement that was imported and not yet matched still answers — «ما انذكر بأي كشف» is never
 *     said about a parcel a statement does carry.
 *   · an ORDER OF OURS the matching found no line for («طلب عندنا لم يذكره الكشف»): a matching row with an order and no
 *     line. It is found through the order.
 *
 * ── WHOSE ──
 *
 * The company and the store are the person's, in every query and in every sub-query: the statement, the matching row and the
 * order each carry them, so a statement of another store can neither be listed nor be reached through an order.
 *
 * ── WHO MAY TYPE A NAME OR A PHONE ──
 *
 * Both are dropped from every clause — the order's and the line's — for a person who may not read customers' numbers
 * (`customers.view`). A box that found a parcel by a number the screen then hides would still say whose number it is: the
 * returns desk's rule (`returnsSearch`), applied to the name as well, because here a row appearing IS the answer. And the
 * company's whole row (`rawRow`) is never searched at all: a phone and a name sit inside it, and a text search over it would
 * be the same oracle through the back door.
 *
 * ── HOW MUCH ──
 *
 * `MAX_HITS` lines at a time, and the true number beside them. Both kinds are counted by the database, not by the page.
 * Read-only: nothing here writes, and no figure is worked out — the three on a hit are the stored ones.
 */

export interface SearchScope {
  companyId: string;
  storeId: string;
}

/** The three tables this reads — a transaction client or the shared one. */
export type SearchDb = Pick<PrismaClient, 'statementLine' | 'settlementMatch' | 'deliveryProvider'>;

/**
 * THE ORDER'S SIDE OF THE QUESTION: the shared order search (`orderSearchOr` — number, reference, waybill, and the customer's
 * name and phone), minus every clause that reads the customer when this person may not. The clauses are told apart by what
 * they read, not by their place in the list, so a field added to the shared builder reaches this one without being copied.
 */
export function orderClauses(q: string, maySeeContact: boolean): Prisma.OrderWhereInput[] {
  const clauses = orderSearchOr(q, { withPhone: maySeeContact }) as Prisma.OrderWhereInput[];
  return maySeeContact ? clauses : clauses.filter((c) => !('customer' in c));
}

/** The order a matching row is tied to, when it is one of this store's and answers the question. */
function tiedOrder(q: string, scope: SearchScope, maySeeContact: boolean): Prisma.OrderWhereInput {
  return { companyId: scope.companyId, storeId: scope.storeId, OR: orderClauses(q, maySeeContact) };
}

/**
 * THE LINES OF THIS STORE'S STATEMENTS THAT MENTION WHAT WAS TYPED.
 *
 * The line's own barcode and reference; the receiver's name and phone as the company wrote them (only for who may read
 * customers' numbers — the phone as typed AND in the stored spelling, the way an order's phone is searched); or an order, of
 * this store, that the matching tied the line to and that answers the order search.
 */
export function lineWhere(q: string, scope: SearchScope, maySeeContact: boolean): Prisma.StatementLineWhereInput {
  const phone = normalizePhoneNumber(q);
  return {
    statement: { companyId: scope.companyId, storeId: scope.storeId },
    OR: [
      { barcode: typed(q) },
      { merchantRef: typed(q) },
      ...(maySeeContact
        ? [
            { receiverName: typed(q) },
            { receiverPhone: typed(phone || q) },
            ...(phone && phone !== q ? [{ receiverPhone: typed(q) }] : []),
          ]
        : []),
      { matches: { some: { companyId: scope.companyId, order: { is: tiedOrder(q, scope, maySeeContact) } } } },
    ],
  };
}

/**
 * THE ORDERS OF OURS THAT A STATEMENT'S MATCHING FOUND NO LINE FOR: a matching row with an order and no line, whose order
 * answers the question. (A row WITH a line is reached through the line above.)
 */
export function orphanWhere(q: string, scope: SearchScope, maySeeContact: boolean): Prisma.SettlementMatchWhereInput {
  return {
    companyId: scope.companyId,
    statementLineId: null,
    statement: { companyId: scope.companyId, storeId: scope.storeId },
    order: { is: tiedOrder(q, scope, maySeeContact) },
  };
}

const STATEMENT_SELECT = {
  id: true,
  reference: true,
  createdAt: true,
  status: true,
  approvedAt: true,
  matchingClosedAt: true,
  // Read here to tell a draft from a statement; never sent.
  fileHash: true,
  currencyCode: true,
  deliveryProviderId: true,
} satisfies Prisma.CourierStatementSelect;

const MATCH_SELECT = {
  id: true,
  result: true,
  resolution: true,
  // The qualifier beside «اعتُمد رقم الشركة» that makes the answer «طلب تبديل» (`isExchange`): without it, an exchange would be
  // read here as an ordinary accepted figure — and said so.
  resolutionKind: true,
  expectedAmount: true,
  statementAmount: true,
  difference: true,
  order: { select: { id: true, orderNumber: true } },
} satisfies Prisma.SettlementMatchSelect;

const LINE_SELECT = {
  barcode: true,
  merchantRef: true,
  statement: { select: STATEMENT_SELECT },
  // A line has one matching row; the newest is read if a re-run ever left two.
  matches: { select: MATCH_SELECT, orderBy: { createdAt: 'desc' }, take: 1 },
} satisfies Prisma.StatementLineSelect;

const ORPHAN_SELECT = {
  ...MATCH_SELECT,
  statement: { select: STATEMENT_SELECT },
} satisfies Prisma.SettlementMatchSelect;

/** Newest statement first; the id then keeps two statements of the same moment — and a statement's own lines — in one order. */
const LINE_ORDER: Prisma.StatementLineOrderByWithRelationInput[] = [
  { statement: { createdAt: 'desc' } },
  { statementId: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];
const ORPHAN_ORDER: Prisma.SettlementMatchOrderByWithRelationInput[] = [
  { statement: { createdAt: 'desc' } },
  { statementId: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

/** The word the collection screen says each state of a statement with — and «مغلق», which it says as a sentence. */
export const STATEMENT_STATE_AR: Record<string, string> = {
  DRAFT: 'مسوّدة',
  IMPORTED: 'مستورد',
  RECEIPTED: 'سُجِّل الاستلام',
  MATCHED: 'مطابَق',
  APPROVED: 'معتمد',
  CLOSED: 'مغلق',
};

/**
 * WHAT STATE A STATEMENT IS IN, by the same predicates the screens gate on: a manual draft; then closed (the matching is
 * closed, the orders settled); then approved (the money is in, the matching still open); then the step it has reached.
 */
export function statementState(s: {
  status: string;
  fileHash: string | null;
  approvedAt: Date | string | null;
  matchingClosedAt: Date | string | null;
}): { key: string; ar: string } {
  const key = isManualDraftHash(s.fileHash)
    ? 'DRAFT'
    : isMatchingClosed({ matchingClosedAt: s.matchingClosedAt, status: s.status, approvedAt: s.approvedAt })
      ? 'CLOSED'
      : isApproved({ status: s.status, approvedAt: s.approvedAt })
        ? 'APPROVED'
        : s.status;
  return { key, ar: STATEMENT_STATE_AR[key] ?? s.status };
}

/**
 * THE ANSWER A PERSON GAVE, in the words the matching screen shows it with: the two figures, «قيد المراجعة» and «طلب تبديل»
 * from the one table of `settlement-difference`; a word it does not know is shown as it is, never dropped.
 *
 * It takes the ROW, not the word, because «طلب تبديل» is not an answer of its own: the stored answer is «اعتُمد رقم الشركة»
 * and the kind beside it says why (`isExchange` — the kind counts only beside that answer, so a kind standing next to any
 * other answer is read as nothing). A row from before the kind existed carries none, and is said as it always was.
 */
export function answerAr(row: { resolution?: string | null; resolutionKind?: string | null } | null | undefined): string | null {
  const resolution = row?.resolution;
  if (!row || !resolution) return null;
  if (isExchange(row)) return EXCHANGE_AR;
  if (resolution === PARKED) return PARKED_AR;
  return (RESOLUTION_AR as Record<string, string>)[resolution] ?? resolution;
}

type Dec = { toString(): string } | number | string | null | undefined;
const figure = (v: Dec): number | null => (v === null || v === undefined ? null : Number(v));

interface StatementRow {
  id: string;
  reference: string;
  createdAt: Date;
  status: string;
  approvedAt: Date | null;
  matchingClosedAt: Date | null;
  fileHash: string;
  currencyCode: string;
  deliveryProviderId: string;
}
interface MatchRow {
  id: string;
  result: string;
  resolution: string | null;
  /** Absent on a row read from a database that has no such column yet: read as «no kind». */
  resolutionKind?: string | null;
  expectedAmount: Dec;
  statementAmount: Dec;
  difference: Dec;
  order: { id: string; orderNumber: string } | null;
}

function hitOf(
  statement: StatementRow,
  match: MatchRow | null,
  line: { barcode: string | null; merchantRef: string | null } | null,
  companies: Map<string, string>
): StatementHit {
  const state = statementState(statement);
  const inStatement: HitStatement = {
    id: statement.id,
    reference: statement.reference,
    company: companies.get(statement.deliveryProviderId) ?? null,
    at: statement.createdAt.toISOString(),
    state: state.key,
    stateAr: state.ar,
    currencyCode: statement.currencyCode,
  };
  return {
    matchId: match?.id ?? null,
    statement: inStatement,
    queue: match && isQueue(match.result) ? match.result : null,
    resultAr: match ? (isQueue(match.result) ? RESULT_AR[match.result] : match.result) : NOT_MATCHED_YET_AR,
    answerAr: answerAr(match),
    // Two fields and nothing beside them, whatever the query selected: an order drags its customer behind it.
    order: match?.order ? { id: match.order.id, orderNumber: match.order.orderNumber } : null,
    barcode: line?.barcode ?? null,
    merchantRef: line?.merchantRef ?? null,
    expected: figure(match?.expectedAmount),
    stated: figure(match?.statementAmount),
    difference: figure(match?.difference),
  };
}

/**
 * THE ANSWER: every line of the store's statements that mentions `q`, newest statement first, at most `MAX_HITS` of them,
 * and how many there are in all. `q` is already cleaned and long enough (`readQuery`); who may read customers' numbers is
 * the caller's to say, from the session.
 */
export async function searchAllStatements(
  db: SearchDb,
  p: { scope: SearchScope; q: string; maySeeContact: boolean }
): Promise<StatementSearchResponse> {
  const { scope, q, maySeeContact } = p;
  const lines = lineWhere(q, scope, maySeeContact);
  const orphans = orphanWhere(q, scope, maySeeContact);

  const [lineTotal, orphanTotal, lineRows, orphanRows] = await Promise.all([
    db.statementLine.count({ where: lines }),
    db.settlementMatch.count({ where: orphans }),
    db.statementLine.findMany({ where: lines, select: LINE_SELECT, orderBy: LINE_ORDER, take: MAX_HITS }),
    db.settlementMatch.findMany({ where: orphans, select: ORPHAN_SELECT, orderBy: ORPHAN_ORDER, take: MAX_HITS }),
  ]);

  // The company's name: the statement names it by id, and the courier is read in the person's own company.
  const providerIds = new Set<string>();
  for (const r of lineRows) providerIds.add((r.statement as StatementRow).deliveryProviderId);
  for (const r of orphanRows) providerIds.add((r.statement as StatementRow).deliveryProviderId);
  const providers =
    providerIds.size === 0
      ? []
      : await db.deliveryProvider.findMany({
          where: { companyId: scope.companyId, id: { in: [...providerIds] } },
          select: { id: true, name: true },
        });
  const companies = new Map(providers.map((x): [string, string] => [x.id, x.name]));

  const ranked = [
    ...lineRows.map((r, i) => ({ r: r.statement as StatementRow, kind: 0, i, hit: hitOf(r.statement as StatementRow, (r.matches[0] as MatchRow | undefined) ?? null, r, companies) })),
    ...orphanRows.map((r, i) => ({ r: r.statement as StatementRow, kind: 1, i, hit: hitOf(r.statement as StatementRow, r as unknown as MatchRow, null, companies) })),
  ];
  // Both lists already arrive in this order: the merge only interleaves them.
  ranked.sort(
    (a, b) =>
      b.r.createdAt.getTime() - a.r.createdAt.getTime() ||
      (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0) ||
      a.kind - b.kind ||
      a.i - b.i
  );

  return { q, hits: ranked.slice(0, MAX_HITS).map((x) => x.hit), total: lineTotal + orphanTotal, limit: MAX_HITS };
}
