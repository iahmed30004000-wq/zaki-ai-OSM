import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { roundMinor } from './money';
import { claimingRowWhere, openRequestWhere } from './match-integrity';
import { normalizePhrase, readCourierWord } from './courier-words';
import { PARKED, PARKED_AR, RESOLUTIONS, RESOLUTION_AR, type Resolution } from './settlement-difference';
import { STATEMENT_CLOSED_SENTENCE } from './settlement-gates';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * THE DECISION ON A DIFFERENCE — WHAT MAY BE SAID, ABOUT WHICH ORDER, AND WHAT IT DOES.
 *
 * «ممكن عادي صار خصم، بس يعتمد رقم الشركة. وإذا غير معتمد أنا رح أتواصل مع الشركة وخط اعتماد رقمنا.»
 *
 * A line of «فرق في المبلغ» is a question with two figures, and until now the answer was a word on the row that
 * changed nothing at all: an order whose difference was ACCEPTED was never settled, and one whose difference
 * was refused looked exactly the same. This file is the rule that gives the word its effect, in one place, so
 * the door that records it, the screen that offers it and the approval that carries it out read the same table.
 *
 * ── THREE SAYINGS ──
 *
 *   ACCEPTED_COURIER  their figure stands. At APPROVAL the order is SETTLED and `collectedAmount` is written
 *                     from their line (the gross: net plus the fee they kept).
 *   OURS_STANDS       our figure stands. The order is NOT settled: it stays PENDING_COLLECTION as a claim on the
 *                     company — expected − what their statement paid — and is closed by a later statement
 *                     («كشف تسوية») whose line pays what remains.
 *   UNDER_REVIEW      a person looked and parked it. Nothing is settled and nothing is claimed.
 *
 * ── THE EFFECT IS CARRIED OUT INSIDE THE APPROVAL ──
 *
 * Never at the moment of saying it. The saying is stored on the match row with its explanation (five
 * characters at least) and the person; the approval — one transaction — settles the orders, after looking at
 * each one AGAIN, so a statement whose import is taken back before approval leaves nothing behind, and an order
 * that changed while the row waited (settled elsewhere, a cancel asked for) stops the approval by name instead
 * of being settled on a stale answer.
 *
 * ── THE MATRIX: WHAT MAY BE SAID ABOUT AN ORDER IN EACH STATE ──
 *
 * See `decisionMatrix`. Pure functions first, then the reads that feed them.
 */

/** The three sayings, in the order the screen offers them. */
export const DECISIONS = [...RESOLUTIONS, PARKED] as const;
export type Decision = Resolution | typeof PARKED;

export const DECISION_AR: Record<Decision, string> = { ...RESOLUTION_AR, [PARKED]: PARKED_AR };

export function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
}

export { BULK_LIMIT, EXPLANATION_SENTENCE, MIN_EXPLANATION, explanationOf } from './decision-words';

/* ───────────────────────────── the order's state ───────────────────────────── */

/** Parcels the statement is the first proof of delivery for. */
export const IN_FLIGHT = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY'] as const;
/** Parcels our own door already recorded as handed over. */
export const DELIVERED_STATES = ['DELIVERED', 'PARTIALLY_DELIVERED'] as const;
/** Parcels coming back. */
export const COMING_BACK = ['RETURN_REQUESTED', 'RETURNED'] as const;

export type StateGroup = 'IN_FLIGHT' | 'DELIVERED' | 'COMING_BACK' | 'OTHER';

export function stateGroup(shippingStatus: string | null | undefined): StateGroup {
  if ((IN_FLIGHT as readonly string[]).includes(String(shippingStatus))) return 'IN_FLIGHT';
  if ((DELIVERED_STATES as readonly string[]).includes(String(shippingStatus))) return 'DELIVERED';
  if ((COMING_BACK as readonly string[]).includes(String(shippingStatus))) return 'COMING_BACK';
  return 'OTHER';
}

export interface DecisionFacts {
  /** The row has an order. */
  hasOrder: boolean;
  shippingStatus: string | null;
  settlementStatus: string | null;
  /** The intents of the cancel / postpone requests asked for and not carried out. */
  openRequests: string[];
  /** Another row (another line, another statement) already holds the order cleanly or by a decision. */
  claimedElsewhere: boolean;
  /** This statement's money has already moved. */
  statementApproved: boolean;
  /** Ours, net — as the row recorded it. */
  expectedAmount: number | null;
  /** Theirs, net. */
  statementAmount: number | null;
  minorUnit: number;
}

export interface Verdict {
  allowed: boolean;
  /** The sentence that says why not; null when allowed. */
  why: string | null;
}
export type Matrix = Record<Decision, Verdict>;

export const WHY = {
  noOrder: 'السطر بلا طلب — اربطه بطلب أولاً',
  settled: 'الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف) — لا بتّ عليه',
  notSent: 'الطلب لم يُسلَّم للشركة بحالته الحالية',
  openRequest: 'عليه طلب إلغاء أو تأجيل مفتوح — أجبه أولاً',
  heldElsewhere: 'الطلب محجوز بسطر آخر',
  approved: STATEMENT_CLOSED_SENTENCE,
  notDeliveredYet: 'الطرد لم يُسجَّل مسلَّماً بعد — لا مطالبة قبل التسليم',
  nothingOwed: 'لا نقص نطالب به — رقم الشركة ليس أقل من رقمنا',
  returnedNoClaim: 'طلب مرتجع — لا مبلغ نطالب به',
  amountOnReturn: 'سطر بمبلغ على طلب مرتجع — راجعه',
  zeroOnTheRoad: 'سطر صفر لطرد لم يُسجَّل مسلَّماً — ليس دليل تسليم',
} as const;

const yes: Verdict = { allowed: true, why: null };
const no = (why: string): Verdict => ({ allowed: false, why });

/**
 * What the company still owes if our figure stands: ours minus what its statement paid, in the currency's own
 * minor unit. Zero or negative means there is nothing to claim.
 */
export function claimOf(row: { expectedAmount: number | null; statementAmount: number | null }, minorUnit: number): number {
  if (row.expectedAmount === null || row.statementAmount === null) return 0;
  return roundMinor(row.expectedAmount - row.statementAmount, minorUnit);
}

/**
 * THE MATRIX. One order's facts in, the verdict on each saying out.
 *
 *   state of the order                    اعتُمد رقم الشركة          رقمنا هو المعتمد         قيد المراجعة
 *   ───────────────────────────────────   ────────────────────────   ──────────────────────   ────────────
 *   في الطريق (شُحن · عند الشركة · فشل)   نعم بمبلغ — دليل التسليم  لا                       نعم
 *   مسلَّم (كلي أو جزئي)                  نعم                        نعم إن كان عندنا نقص      نعم
 *   راجع (طلب إرجاع · مُرجَع)              نعم إن كان سطر الصفر       لا                       نعم
 *   غير ذلك (لم يُشحن · مُلغى)             لا                         لا                       نعم
 *   مُسوّى أصلاً                           لا                         لا                       نعم
 *   عليه طلب إلغاء/تأجيل مفتوح             لا                         لا                       نعم
 *   محجوز بسطر آخر                         لا                         لا                       نعم
 *   الكشف معتمد (مغلق نهائياً)             لا (كشف تسوية)             لا (كشف تسوية)           لا (كشف تسوية)
 *
 * WHY EACH «NO»: a figure can only be accepted or claimed for a parcel the money is about. An order that never
 * left, or is settled, or has a cancel waiting, or is held by another row, is not that parcel yet — and the
 * third saying exists exactly so that such a row is not left looking unanswered.
 */
export function decisionMatrix(f: DecisionFacts): Matrix {
  /*
   * A CLOSED STATEMENT TAKES NO ANSWER AT ALL — asked first, whatever the order is.
   *
   * It used to take «رقمنا» and «قيد المراجعة» after the approval because they move no money. But «قيد المراجعة»
   * written over a row answered «رقمنا» took the claim off the company without a word (RV313), and «رقمنا» written
   * after the fact opened a claim that no approval had looked at. The statement is closed for good
   * (settlement-gates); the correction is a settlement statement.
   */
  if (f.statementApproved) {
    return { ACCEPTED_COURIER: no(WHY.approved), OURS_STANDS: no(WHY.approved), [PARKED]: no(WHY.approved) };
  }
  if (!f.hasOrder) {
    return { ACCEPTED_COURIER: no(WHY.noOrder), OURS_STANDS: no(WHY.noOrder), [PARKED]: no(WHY.noOrder) };
  }
  if (f.settlementStatus === 'SETTLED') {
    return { ACCEPTED_COURIER: no(WHY.settled), OURS_STANDS: no(WHY.settled), [PARKED]: yes };
  }

  const group = stateGroup(f.shippingStatus);
  const claim = claimOf({ expectedAmount: f.expectedAmount, statementAmount: f.statementAmount }, f.minorUnit);

  // The reasons that stop BOTH figures, in the order a person should meet them.
  let both: string | null = null;
  if (group === 'OTHER') both = WHY.notSent;
  else if (f.openRequests.some((i) => i === 'CANCEL' || i === 'POSTPONE')) both = WHY.openRequest;
  else if (f.claimedElsewhere) both = WHY.heldElsewhere;

  let accepted: Verdict;
  let ours: Verdict;
  if (both) {
    accepted = no(both);
    ours = no(both);
  } else {
    if (group === 'COMING_BACK') accepted = f.statementAmount === 0 ? yes : no(WHY.amountOnReturn);
    // A statement is the proof of delivery of a parcel on the road only by stating money for it: a line of zero
    // beside «مؤجلة» is the company saying it did NOT deliver, and accepting it would deliver the parcel for nothing.
    else if (group === 'IN_FLIGHT' && f.statementAmount === 0) accepted = no(WHY.zeroOnTheRoad);
    else accepted = yes;

    if (group === 'IN_FLIGHT') ours = no(WHY.notDeliveredYet);
    else if (group === 'COMING_BACK') ours = no(WHY.returnedNoClaim);
    else ours = claim > 0 ? yes : no(WHY.nothingOwed);
  }

  return { ACCEPTED_COURIER: accepted, OURS_STANDS: ours, [PARKED]: yes };
}

/**
 * THE MATRIX AS IT IS PUBLISHED — one row per state, in words. The guide and the pull request print it, and the
 * test holds it to `decisionMatrix`, so what is written is what the code does.
 */
export const DECISION_MATRIX: { state: string; accepted: string; ours: string; parked: string }[] = [
  { state: 'في الطريق', accepted: 'نعم بمبلغ — والكشف دليل التسليم', ours: 'لا', parked: 'نعم' },
  { state: 'مسلَّم', accepted: 'نعم', ours: 'نعم إن كان عندنا نقص', parked: 'نعم' },
  { state: 'راجع', accepted: 'نعم إن كان سطر الصفر', ours: 'لا', parked: 'نعم' },
  { state: 'لم يُشحن أو مُلغى', accepted: 'لا', ours: 'لا', parked: 'نعم' },
  { state: 'مُسوّى أصلاً', accepted: 'لا', ours: 'لا', parked: 'نعم' },
  { state: 'عليه طلب إلغاء أو تأجيل مفتوح', accepted: 'لا', ours: 'لا', parked: 'نعم' },
  { state: 'محجوز بسطر آخر', accepted: 'لا', ours: 'لا', parked: 'نعم' },
  { state: 'الكشف معتمد', accepted: 'لا — كشف تسوية', ours: 'لا — كشف تسوية', parked: 'لا — كشف تسوية' },
];

/* ───────────────────────────── the group of a bulk decision ───────────────────────────── */

/**
 * «BULK FOR LINES WITH THE SAME COURIER WORD».
 *
 * A known word groups by what it MEANS (so «مؤجل» and «مؤجلة» are one group, as they are one reading
 * everywhere); a word the table does not know groups by its own normalised spelling; a blank cell is its own
 * group. Two lines whose words differ are never decided together.
 */
export function wordGroupKey(status: string | null | undefined): string {
  const reading = readCourierWord(status);
  if (!reading) return 'NONE';
  return reading.known ? `MEANS:${reading.outcome}` : `WORD:${normalizePhrase(reading.phrase)}`;
}

/* ───────────────────────────── what is written ───────────────────────────── */

/** The data of the match row. One shape for the single door and the bulk door. */
export function decisionData(p: { resolution: Decision; note: string; userId: string; at?: Date }) {
  return {
    resolution: p.resolution,
    resolutionNote: p.note,
    resolvedById: p.userId,
    resolvedAt: p.at ?? new Date(),
  };
}

/** The internal note written on the order, where an agent who gave a discount would have written it. */
export function decisionNoteBody(p: { statement: string; resolution: Decision; gap: number | null; note: string }): string {
  return `مطابقة كشف ${p.statement}: ${DECISION_AR[p.resolution]}` + (p.gap !== null ? ` — الفرق ${p.gap}` : '') + `. ${p.note}`;
}

/* ───────────────────────────── the reads ───────────────────────────── */

export interface DecisionRow {
  id: string;
  orderId: string | null;
  expectedAmount: number | null;
  statementAmount: number | null;
  /** The statement's approval stamp. */
  approvedAt: Date | string | null;
}

/**
 * The facts the matrix reads, for many rows at once: three queries however many rows there are.
 *
 * `claimedElsewhere` is any OTHER row — another line of this file, another statement — that holds the order
 * cleanly or by a decision. It is deliberately wider than the matcher's own question: a person deciding an
 * order that another statement is about to settle should be told so before, not at approval.
 */
export async function loadDecisionFacts(
  tx: Tx,
  p: { companyId: string; storeId: string; minorUnit: number; rows: DecisionRow[] }
): Promise<Map<string, DecisionFacts>> {
  const out = new Map<string, DecisionFacts>();
  const orderIds = [...new Set(p.rows.flatMap((r) => (r.orderId ? [r.orderId] : [])))];
  if (orderIds.length === 0) {
    for (const r of p.rows) out.set(r.id, factsOf(r, undefined, [], false, p.minorUnit));
    return out;
  }

  const orders = await tx.order.findMany({
    // The statement’s own store: an order of another store is not one this statement can be about.
    where: { id: { in: orderIds }, companyId: p.companyId, storeId: p.storeId },
    select: { id: true, shippingStatus: true, settlementStatus: true },
  });
  const requests = await tx.orderChangeRequest.findMany({
    where: { companyId: p.companyId, orderId: { in: orderIds }, ...openRequestWhere() },
    select: { orderId: true, intent: true },
  });
  const holders = await tx.settlementMatch.findMany({
    where: { companyId: p.companyId, orderId: { in: orderIds }, id: { notIn: p.rows.map((r) => r.id) }, OR: claimingRowWhere() },
    select: { orderId: true },
  });
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  const held = new Set(holders.flatMap((h) => (h.orderId ? [h.orderId] : [])));

  for (const r of p.rows) {
    out.set(
      r.id,
      factsOf(
        r,
        r.orderId ? orderOf.get(r.orderId) : undefined,
        requests.filter((q) => q.orderId === r.orderId).map((q) => q.intent),
        !!r.orderId && held.has(r.orderId),
        p.minorUnit
      )
    );
  }
  return out;
}

function factsOf(
  r: DecisionRow,
  order: { shippingStatus: string; settlementStatus: string } | undefined,
  openRequests: string[],
  claimedElsewhere: boolean,
  minorUnit: number
): DecisionFacts {
  return {
    hasOrder: !!order,
    shippingStatus: order?.shippingStatus ?? null,
    settlementStatus: order?.settlementStatus ?? null,
    openRequests,
    claimedElsewhere,
    statementApproved: r.approvedAt != null,
    expectedAmount: r.expectedAmount,
    statementAmount: r.statementAmount,
    minorUnit,
  };
}

/* ───────────────────────────── the claim on the company ───────────────────────────── */

export interface OpenClaim {
  /** Still owed: the latest approved «رقمنا» row's expected − what that statement paid. */
  remaining: number;
  /** Everything the earlier statements paid for this order, gross (net + fee) — what the order has been paid so far. */
  paidGross: number;
}

type Num = Prisma.Decimal | number | string | null | undefined;

export interface ClaimRow {
  orderId: string | null;
  expectedAmount: Num;
  statementAmount: Num;
  statementFee?: Num;
  statement?: { approvedAt: Date | string | null } | null;
}

/**
 * A STATEMENT LINE MAY BE A PAYMENT ON A CLAIM.
 *
 * An order whose difference was answered «رقمنا هو المعتمد» on an APPROVED statement is owed the rest by the
 * company. When a later statement («كشف تسوية») names it, the line is not measured against the whole order any
 * more — the part already paid is not expected twice — but against what remains. A line that pays exactly that
 * is clean; one that pays less, or more, is a difference like any other and is answered like one.
 *
 * Only an order that is not SETTLED has a claim; the caller passes only those. The LATEST approved row wins,
 * because a part-payment answered «رقمنا» again is judged against the remainder and writes the new remainder
 * as its own expectation.
 */
export async function openClaimsFor(
  tx: Tx,
  p: { companyId: string; orderIds: string[]; excludeStatementId: string; minorUnit: number }
): Promise<Map<string, OpenClaim>> {
  if (p.orderIds.length === 0) return new Map();
  const rows = await tx.settlementMatch.findMany({
    where: {
      companyId: p.companyId,
      orderId: { in: p.orderIds },
      resolution: 'OURS_STANDS',
      statementId: { not: p.excludeStatementId },
      statement: { approvedAt: { not: null } },
    },
    select: {
      orderId: true, expectedAmount: true, statementAmount: true, statementFee: true,
      statement: { select: { approvedAt: true } },
    },
  });
  return claimsFromRows(Array.isArray(rows) ? rows : [], p.minorUnit);
}

/** Pure half of `openClaimsFor`: group by order, the latest approval wins, drop what is no longer owed. */
export function claimsFromRows(rows: ClaimRow[], minorUnit: number): Map<string, OpenClaim> {
  const byOrder = new Map<string, ClaimRow[]>();
  for (const r of rows) {
    if (!r.orderId || r.expectedAmount == null || r.statementAmount == null) continue;
    byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
  }
  const out = new Map<string, OpenClaim>();
  for (const [orderId, list] of byOrder) {
    const at = (r: ClaimRow) => (r.statement?.approvedAt ? new Date(r.statement.approvedAt).getTime() : 0);
    const latest = [...list].sort((a, b) => at(b) - at(a))[0];
    const remaining = claimOf(
      { expectedAmount: Number(latest.expectedAmount), statementAmount: Number(latest.statementAmount) },
      minorUnit
    );
    if (remaining <= 0) continue;
    out.set(orderId, { remaining, paidGross: paidGross(list, minorUnit) });
  }
  return out;
}

/** What earlier statements paid for one order, gross: each row's net plus the fee the courier kept. */
export function paidGross(rows: { statementAmount: Num; statementFee?: Num }[], minorUnit: number): number {
  return roundMinor(
    rows.reduce((sum, r) => sum + (r.statementAmount == null ? 0 : Number(r.statementAmount) + Number(r.statementFee ?? 0)), 0),
    minorUnit
  );
}

/* ───────────────────────────── the approval's re-check ───────────────────────────── */

/**
 * THE CONDITIONS AN ORDER MUST STILL MEET AT THE MOMENT OF APPROVAL — written as the WHERE of the claim itself.
 *
 * Not settled by anyone else meanwhile (the hand collection, another statement approved first — RV291), and no
 * cancel or postponement asked for since the line was matched. Read as the filter of the very write that settles
 * the order, so there is no gap between the check and the act: an order that fails it is simply not claimed, the
 * count falls short, and the approval stops and names it.
 */
export function stillSettlableWhere(companyId: string, ids: string[]): Prisma.OrderWhereInput {
  return {
    id: { in: ids },
    companyId,
    settlementStatus: { not: 'SETTLED' },
    changeRequests: { none: openRequestWhere() },
  };
}

/**
 * The same for the orders a PERSON's decision settles, which also re-asks the one thing the decision rested on:
 * the state of the parcel. A parcel our door recorded as delivered may take their figure; one on the road takes it
 * only with money stated; one coming back takes it only as a line of zero. (The matrix at the time of saying —
 * checked again at the time of doing.)
 */
export function stillAcceptableWhere(companyId: string, ids: string[], zeroLineIds: string[]): Prisma.OrderWhereInput {
  const moneyIds = ids.filter((id) => !zeroLineIds.includes(id));
  return {
    ...stillSettlableWhere(companyId, ids),
    OR: [
      { shippingStatus: { in: [...DELIVERED_STATES] } },
      ...(moneyIds.length > 0 ? [{ id: { in: moneyIds }, shippingStatus: { in: [...IN_FLIGHT] } }] : []),
      ...(zeroLineIds.length > 0 ? [{ id: { in: zeroLineIds }, shippingStatus: { in: [...COMING_BACK] } }] : []),
    ],
  };
}
