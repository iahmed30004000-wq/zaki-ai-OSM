import type { Prisma } from '@prisma/client';
import { roundMinor } from './money';
import { orderSearchOr } from './order-filters';
import { claimingRowWhere, MANUAL_MATCH } from './match-integrity';
import { accrueForOrder } from './commission';
import { consumeOrderStock } from './stock-consumption';
import { releaseOrderLines } from './reservation';
import { STATEMENT_CLOSED_SENTENCE, isApproved } from './settlement-gates';
import { isManualDraftHash, isManualHash } from './manual-statement-rules';
import { expectedAmountFor, judgeLine, SETTLEMENT_ORDER_SELECT } from './settlement';
import { COMING_BACK, IN_FLIGHT, stateGroup } from './settlement-decisions';
import {
  BoxOrderMoved,
  REPLACEMENT_SOURCE_SELECT,
  boxUnits,
  createReplacement,
  reshapeToBox,
  type BoxLine,
  type ReplacementResult,
  type ReplacementSource,
} from './replacement-order';
import { ACTIVITY_ROLE, SWAP_ACTION } from './superseded';

type Tx = Prisma.TransactionClient;

/**
 * «كان من طرد طلب آخر» — THE PARCEL SWAP, DECIDED ON THE STATEMENT LINE.
 *
 *   «طلب B بيتلغى بعد الشحن، والمندوب بيعطي صندوق Y للزبون A (صاحب الطلب X) وبيحصّل سعر Y.»
 *
 * The company's file then says Y «تم» with the money and X «مرتجع» at zero, and nothing in it is wrong: the
 * courier delivered a box and collected for it. What is wrong is OUR picture — the money sits on B's order, the
 * goods on B's shelf count, and A, who took delivery and paid, reads as a customer who refused.
 *
 * ── ONE TRANSACTION, FIVE FACTS ──
 *
 *   X′   a new order, A's: A's customer, the sale's people and the campaign from X; the goods from Y's box; the
 *        price what A paid (the line's gross); the fee the leg's; DELIVERED, with the statement's dates. If a
 *        reorder already raised an UNSHIPPED replacement for X, that one is reshaped into X′ instead.
 *   line the MANUAL match of the money line moves from Y to X′ — judged by the matcher's own `judgeLine`.
 *   X    ends as a return (WRONG_PRODUCT); its own line is judged again, now against a parcel coming back.
 *   Y    ends: its box was given to X′'s customer. A receipt for no goods when the whole box went; otherwise it
 *        waits for the pieces that did not.
 *   asks the open cancel / postpone / edit requests on X and Y are closed — their parcels have an end now.
 *
 * ── WRITTEN AS DIFFERENCES ──
 *
 * The doors have already written things about these orders, and this writes what is LEFT: Y's units are released
 * only if still held; A's refusal is taken back only if a door counted it; B's cancellation is counted only if no
 * door has. Nothing here moves a fils of money — the wallet, SETTLED and the amount on the order are the
 * approval's, as ever: X′ is matched to the line, so approving the statement settles it.
 *
 * ── WHAT IS NOT HERE ──
 *
 * An APPROVED statement (the correction that moves consumption and commission off Y after the fact) is refused
 * in words; it goes through «كشف تسوية».
 */

/* ───────────────────────────── the words ───────────────────────────── */

export const SWAP_WHY = {
  notFound: 'الكشف أو سطره غير موجود',
  orderNotFound: 'الطلب غير موجود',
  approved: STATEMENT_CLOSED_SENTENCE,
  manual: 'هذا كشف يدوي — التبديل لسطور كشف الشركة فقط',
  notAMoneyLine: 'التبديل على سطر «فرق في المبلغ» له طلب، ولم يُربط يدوياً',
  decided: 'للسطر بتّ مكتوب — لا يُبدَّل بعده',
  noMoney: 'سطر بلا مبلغ — ما في مبلغ دفعه الزبون ليُبنى عليه البديل',
  twoLines: 'لطلب الصندوق سطر آخر في هذا الكشف — راجع السطرين أولاً',
  sameOrder: 'اختر طلب الزبون الذي استلم — غير طلب هذا السطر',
  otherStore: 'الطلب من متجر آخر',
  otherCurrency: 'عملة الطلبين أو الكشف مختلفة',
  otherCourier: 'الطلب مع شركة شحن غير صاحبة الكشف',
  sameCustomer: 'الطلبان لنفس الزبون — هذا ليس تبديل طرد',
  boxCounted: 'صندوق الطلب انعدّ بالمكتب — لا يُبدَّل',
  boxNotOnTheRoad: 'الطلب صاحب الصندوق ليس في الطريق بحالته الحالية — لا يُبدَّل',
  boxNotCancelled: 'الطلب صاحب الصندوق لم يُطلب إلغاؤه — سجّل إلغاءه (طلب إلغاء بعد الشحن) ثم أعد',
  ownerNotOnTheRoad: 'طلب الزبون ليس في الطريق ولا راجعاً بحالته الحالية — لا يُبدَّل',
  ownerDelivered: 'طلب الزبون مسجّل مسلَّماً — لا تبديل عليه',
  settled: 'الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف)',
  claimedElsewhere: 'الطلب محجوز بكشف آخر',
  claimedHere: 'الطلب محجوز بسطر آخر من هذا الكشف',
  openClaim: 'على الطلب مطالبة مفتوحة على الشركة — سكّرها أول',
  boxHasAddOns: 'طلب الصندوق فيه إضافات — ما بيصير نسجّل تبديلو من هون',
  replaced: 'للطلب بديل خرج من المخزن — لا تبديل فوقه',
  moved: 'تغيّر وضع طلب أثناء العمل — حدّث الصفحة وأعد',
  priceDrift: 'تعذّر بناء سعر البديل مطابقاً لسطر الكشف — لم يُكتب شيء',
} as const;

export function piecesSentence(box: number): string {
  return box === 1 ? 'الصندوق قطعة واحدة فقط' : `عدد القطع من 1 إلى ${box} — هذا ما في الصندوق`;
}

/** A stop that carries its own answer: the transaction rolls back and the route sends this. */
export class SwapRefused extends Error {
  constructor(readonly status: number, readonly body: { error: string; code: string; reasons?: string[] }) {
    super(body.code);
  }
}

const refuse = (status: number, code: string, error: string): never => {
  throw new SwapRefused(status, { error, code });
};

/* ───────────────────────────── what is read ───────────────────────────── */

/** An order as the swap reads it: its states, its lines as the money rule reads them, and its replacement. */
const SWAP_ORDER_SELECT = {
  ...REPLACEMENT_SOURCE_SELECT,
  ...SETTLEMENT_ORDER_SELECT,
  companyId: true,
  version: true,
  confirmationStatus: true,
  settlementStatus: true,
  shippingStatus: true,
  deliveryProviderId: true,
  shippedAt: true,
  labelPrintedAt: true,
  trackingNumber: true,
  shippingBatchId: true,
  returnReason: true,
  merchantRef: true,
  items: {
    select: {
      ...SETTLEMENT_ORDER_SELECT.items.select,
      id: true,
      productId: true,
      productName: true,
      reservedQty: true,
      createdAt: true,
    },
  },
  returnReceipt: { select: { id: true, courierFeeAmount: true } },
  replacedBy: {
    select: {
      id: true,
      orderNumber: true,
      version: true,
      shippingStatus: true,
      shippedAt: true,
      labelPrintedAt: true,
      trackingNumber: true,
      shippingBatchId: true,
      addOns: { select: { id: true } },
    },
  },
  customer: { select: { id: true, fullName: true, phone: true } },
} as const;

type SwapOrder = Prisma.OrderGetPayload<{ select: typeof SWAP_ORDER_SELECT }>;

/** The orders a swap may name as the customer's: on the road, or already coming back. */
const OWNER_STATES = [...IN_FLIGHT, ...COMING_BACK] as const;

/** Has an unshipped replacement the swap can reshape into the sale? */
export function reusableReplacement(x: Pick<SwapOrder, 'replacedBy'>): boolean {
  const r = x.replacedBy;
  if (!r) return false;
  return (
    ['NOT_READY', 'READY_FOR_SHIPPING', 'PACKING'].includes(r.shippingStatus) &&
    !r.shippedAt &&
    !r.labelPrintedAt &&
    !r.trackingNumber &&
    !r.shippingBatchId &&
    r.addOns.length === 0
  );
}

/** Facts about the two orders that are not on the orders themselves. */
export interface SwapContext {
  /** The statement's own facts. */
  statement: { storeId: string; currencyCode: string; deliveryProviderId: string };
  /** A cancel was asked for on the box's order (open or answered), or it ended. */
  cancelAsked: boolean;
}

export interface Blocker {
  code: string;
  error: string;
}

/**
 * WHY THIS ORDER'S BOX CANNOT BE SWAPPED — pure, so the dialog says it before the press and the door after it.
 */
export function boxBlockers(
  y: Pick<SwapOrder, 'shippingStatus' | 'settlementStatus' | 'returnReceipt' | 'storeId' | 'currency' | 'deliveryProviderId' | 'addOns'>,
  ctx: SwapContext
): Blocker[] {
  const out: Blocker[] = [];
  if (y.returnReceipt) out.push({ code: 'BOX_COUNTED', error: SWAP_WHY.boxCounted });
  else if (!(IN_FLIGHT as readonly string[]).includes(y.shippingStatus)) {
    out.push({ code: 'BOX_NOT_ON_THE_ROAD', error: SWAP_WHY.boxNotOnTheRoad });
  }
  if (y.settlementStatus === 'SETTLED') out.push({ code: 'SETTLED', error: SWAP_WHY.settled });
  if (y.storeId !== ctx.statement.storeId) out.push({ code: 'OTHER_STORE', error: SWAP_WHY.otherStore });
  if (y.currency !== ctx.statement.currencyCode) out.push({ code: 'OTHER_CURRENCY', error: SWAP_WHY.otherCurrency });
  if (y.deliveryProviderId !== ctx.statement.deliveryProviderId) out.push({ code: 'OTHER_COURIER', error: SWAP_WHY.otherCourier });
  if (!ctx.cancelAsked) out.push({ code: 'BOX_NOT_CANCELLED', error: SWAP_WHY.boxNotCancelled });
  // The upsell leaves in the same box and is drawn from stock with it; the sale is built from the lines alone, so a
  // box with an add-on would release more than the sale draws. Refused whole, before any write.
  if (y.addOns.length > 0) out.push({ code: 'BOX_HAS_ADD_ONS', error: SWAP_WHY.boxHasAddOns });
  return out;
}

/**
 * WHY THIS ORDER CANNOT BE THE ONE THAT TOOK THE BOX.
 *
 * Refused: the same order, the same customer, another store, another currency, another courier, a parcel not on
 * the road or coming back (a delivered one already has its own money), a settled one, and one whose replacement
 * has left the warehouse — that sale is already somebody's.
 */
export function ownerBlockers(
  x: Pick<
    SwapOrder,
    'id' | 'customerId' | 'storeId' | 'currency' | 'deliveryProviderId' | 'shippingStatus' | 'settlementStatus' | 'replacedBy'
  >,
  y: Pick<SwapOrder, 'id' | 'customerId'>,
  ctx: SwapContext
): Blocker[] {
  const out: Blocker[] = [];
  if (x.id === y.id) out.push({ code: 'SAME_ORDER', error: SWAP_WHY.sameOrder });
  if (x.customerId === y.customerId) out.push({ code: 'SAME_CUSTOMER', error: SWAP_WHY.sameCustomer });
  if (x.storeId !== ctx.statement.storeId) out.push({ code: 'OTHER_STORE', error: SWAP_WHY.otherStore });
  if (x.currency !== ctx.statement.currencyCode) out.push({ code: 'OTHER_CURRENCY', error: SWAP_WHY.otherCurrency });
  if (x.deliveryProviderId !== ctx.statement.deliveryProviderId) out.push({ code: 'OTHER_COURIER', error: SWAP_WHY.otherCourier });
  if (x.settlementStatus === 'SETTLED') out.push({ code: 'SETTLED', error: SWAP_WHY.settled });
  if (!(OWNER_STATES as readonly string[]).includes(x.shippingStatus)) {
    out.push(
      ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(x.shippingStatus)
        ? { code: 'OWNER_DELIVERED', error: SWAP_WHY.ownerDelivered }
        : { code: 'OWNER_NOT_ON_THE_ROAD', error: SWAP_WHY.ownerNotOnTheRoad }
    );
  }
  if (x.replacedBy && !reusableReplacement(x)) out.push({ code: 'REPLACED', error: SWAP_WHY.replaced });
  return out;
}

/* ───────────────────────────── the pure plan ───────────────────────────── */

/** What the line says the customer paid, split into the parts the order needs. */
export function paidFromLine(
  line: { amount: unknown; fee?: unknown | null },
  minorUnit: number
): { net: number; fee: number; paid: number } {
  const net = roundMinor(Number(line.amount), minorUnit);
  const fee = line.fee == null ? 0 : roundMinor(Number(line.fee), minorUnit);
  return { net, fee, paid: roundMinor(net + fee, minorUnit) };
}

/**
 * THE ORDER THE BOX WAS PACKED IN: by when each line was written, then by its id.
 *
 * The same order the new sale reads the box in (`readAndPriceBox` asks the database for it), so «the first two
 * pieces» means the same two pieces on both sides. Done here in JavaScript because a reusable select written as
 * a constant cannot carry an `orderBy` array without losing its types.
 */
export function inPackingOrder<T extends { id: string; createdAt?: Date | null }>(lines: readonly T[]): T[] {
  return [...lines].sort(
    (a, b) =>
      (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * HOW MANY PIECES OF EACH LINE OF THE BOX WENT, and how many are still owed back — by the order the box was packed.
 */
export function splitBox(
  lines: ReadonlyArray<BoxLine & { reservedQty?: number }>,
  pieces: number
): { id: string; shipped: number; taken: number; remaining: number; reserved: number }[] {
  let left = pieces;
  return lines.map((l) => {
    const shipped = l.quantity + l.freeQuantity;
    const taken = Math.min(left, shipped);
    left -= taken;
    const remaining = shipped - taken;
    return { id: l.id, shipped, taken, remaining, reserved: Math.min(l.reservedQty ?? 0, remaining) };
  });
}

/* ───────────────────────────── the door ───────────────────────────── */

export interface SwapInput {
  companyId: string;
  storeId: string;
  statementId: string;
  matchId: string;
  /** The order of the customer who took the box (X). */
  ownerOrderId: string;
  pieces: number;
  /** The customer's own box came back. Said by the person; it decides what the returns desk is told. */
  ownerBoxBack: boolean;
  user: { id: string; name?: string | null; role: string };
  minorUnit: number;
  orderPrefix: string;
  /** Retry counter for an order-number clash (the route loops, as the transfer does). */
  attempt: number;
  allowNegativeStock: boolean;
  /** Test seam: the clock. */
  now?: Date;
}

export interface SwapResult {
  reference: string;
  line: { matchId: string; result: string; expected: number; stated: number };
  /** X′ — the order that carries A's sale. */
  sale: { id: string; orderNumber: string; total: number; fee: number; currency: string; reshaped: boolean };
  /** X — the customer's own order, now a return. */
  owner: { id: string; orderNumber: string; boxBack: boolean };
  /** Y — the order whose box was given away. */
  box: { id: string; orderNumber: string; endedAs: 'RETURNED' | 'RETURN_REQUESTED'; pieces: number; total: number };
  /** The Y row as read, for the announcement. */
  boxRow: SwapOrder;
  stock: { released: number; consumed: number };
  counters: { customerDelivered: number; customerRefusalTakenBack: boolean; boxCustomerCancelled: boolean };
  commission: { created: number; amount: number | null };
  closedRequests: number;
}

const SQL_LOCK_STATEMENT = (tx: Tx, id: string) => tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${id} FOR UPDATE`;
const SQL_LOCK_ORDER = (tx: Tx, id: string) => tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${id} FOR UPDATE`;

/** The request statuses that are still asking for something. */
const OPEN_REQUEST_WHERE = (companyId: string, orderId: string): Prisma.OrderChangeRequestWhereInput => ({
  companyId,
  orderId,
  OR: [{ status: 'PENDING' }, { status: 'APPROVED', appliedAt: null }],
});

/** Did a door already count this order's refusal against its customer? (A nothing-taken record.) */
async function aDoorCountedIt(tx: Tx, companyId: string, orderId: string): Promise<boolean> {
  const n = await tx.orderActivity.count({
    where: { companyId, orderId, action: 'PARTIAL_DELIVERY_RECORDED', newStatus: 'RETURNED' },
  });
  return n > 0;
}

/** The facts the verdicts need from outside the order rows. */
async function contextOf(
  tx: Tx,
  p: { companyId: string; y: Pick<SwapOrder, 'id' | 'confirmationStatus'>; statement: SwapContext['statement'] }
): Promise<SwapContext> {
  const asked = await tx.orderChangeRequest.count({
    where: { companyId: p.companyId, orderId: p.y.id, intent: 'CANCEL', status: { in: ['PENDING', 'APPROVED'] } },
  });
  return {
    statement: p.statement,
    cancelAsked: asked > 0 || ['CANCELLED', 'REJECTED'].includes(p.y.confirmationStatus),
  };
}

/** The sentence beside the line, in the words the matcher writes beside a row. */
export const lineNote = (boxNumber: string, saleNumber: string) =>
  `تبديل طرد: بضاعة الطلب ${boxNumber} سُلِّمت لزبون الطلب ${saleNumber}`;

/**
 * THE SWAP — inside the caller's transaction. Everything above is its reason; this is its order of work.
 *
 * The order of the writes matters: the statement is locked first and the two orders after it (by id, so two
 * swaps cannot wait on each other), every state is read AFTER the locks, and each claim on an order is a
 * conditional write whose count must be 1 — so a press that raced this one finds the order moved and stops.
 */
export async function recordParcelSwap(tx: Tx, p: SwapInput): Promise<SwapResult> {
  const at = p.now ?? new Date();

  // ── the statement, locked: an approval cannot slip in between the reads and the writes ──
  await SQL_LOCK_STATEMENT(tx, p.statementId);
  const statement = await tx.courierStatement.findFirst({
    where: { id: p.statementId, companyId: p.companyId, storeId: p.storeId },
    select: {
      id: true, status: true, approvedAt: true, reference: true, deliveryProviderId: true,
      currencyCode: true, fileHash: true, periodTo: true, storeId: true,
    },
  });
  if (!statement) return refuse(404, 'NOT_FOUND', SWAP_WHY.notFound);
  if (isApproved(statement)) return refuse(409, 'ALREADY_APPROVED', SWAP_WHY.approved);
  if (isManualHash(statement.fileHash) || isManualDraftHash(statement.fileHash)) {
    return refuse(409, 'MANUAL_STATEMENT', SWAP_WHY.manual);
  }

  // ── the line ──
  const match = await tx.settlementMatch.findFirst({
    where: { id: p.matchId, statementId: p.statementId, companyId: p.companyId },
    select: {
      id: true, result: true, matchedBy: true, resolution: true, orderId: true, statementLineId: true,
      statementLine: { select: { amount: true, fee: true, status: true } },
    },
  });
  if (!match) return refuse(404, 'NOT_FOUND', SWAP_WHY.notFound);
  if (match.resolution) return refuse(409, 'DECIDED', SWAP_WHY.decided);
  if (match.result !== 'MISMATCHED' || !match.orderId || !match.statementLine || match.matchedBy === MANUAL_MATCH) {
    return refuse(409, 'NOT_SWAPPABLE', SWAP_WHY.notAMoneyLine);
  }
  const line = match.statementLine;
  const { net, fee, paid } = paidFromLine(line, p.minorUnit);
  if (!(net > 0)) return refuse(409, 'NO_MONEY', SWAP_WHY.noMoney);

  // ── the two orders, locked by id and read after the locks ──
  if (match.orderId === p.ownerOrderId) return refuse(409, 'SAME_ORDER', SWAP_WHY.sameOrder);
  for (const id of [match.orderId, p.ownerOrderId].sort()) await SQL_LOCK_ORDER(tx, id);
  const y = await tx.order.findFirst({ where: { id: match.orderId, companyId: p.companyId }, select: SWAP_ORDER_SELECT });
  const x = await tx.order.findFirst({ where: { id: p.ownerOrderId, companyId: p.companyId }, select: SWAP_ORDER_SELECT });
  if (!y || !x) return refuse(404, 'ORDER_NOT_FOUND', SWAP_WHY.orderNotFound);

  const ctx = await contextOf(tx, { companyId: p.companyId, y, statement });
  const stops = [...boxBlockers(y, ctx), ...ownerBlockers(x, y, ctx)];
  if (stops.length > 0) {
    throw new SwapRefused(409, { error: stops[0].error, code: stops[0].code, reasons: stops.map((s) => s.error) });
  }

  const boxTotal = boxUnits(y.items);
  if (!Number.isInteger(p.pieces) || p.pieces < 1 || p.pieces > boxTotal) {
    return refuse(400, 'PIECES_OUT_OF_RANGE', piecesSentence(boxTotal));
  }

  // ── who else holds either order ──
  const holders = await tx.settlementMatch.findMany({
    where: {
      companyId: p.companyId,
      orderId: { in: [x.id, y.id] },
      id: { not: match.id },
      statementLineId: { not: null },
      OR: claimingRowWhere(),
    },
    select: { orderId: true, statementId: true, statement: { select: { reference: true } } },
  });
  // A claim on the company («رقمنا هو المعتمد») left open on either order: the sale is paid by this line, and a later
  // settlement statement would pay the claim again. Any statement, approved or not.
  const claims = await tx.settlementMatch.count({
    where: { companyId: p.companyId, orderId: { in: [x.id, y.id] }, resolution: 'OURS_STANDS' },
  });
  if (claims > 0) return refuse(409, 'OPEN_CLAIM', SWAP_WHY.openClaim);
  const elsewhere = holders.filter((h) => h.statementId !== p.statementId);
  if (elsewhere.length > 0) {
    const refs = [...new Set(elsewhere.map((h) => h.statement.reference))].join('، ');
    return refuse(409, 'CLAIMED_ELSEWHERE', `${SWAP_WHY.claimedElsewhere}: ${refs}`);
  }
  if (holders.length > 0) return refuse(409, 'CLAIMED_HERE', SWAP_WHY.claimedHere);
  const sameBoxLines = await tx.settlementMatch.count({
    where: { companyId: p.companyId, statementId: p.statementId, orderId: y.id, id: { not: match.id } },
  });
  if (sameBoxLines > 0) return refuse(409, 'TWO_LINES', SWAP_WHY.twoLines);

  // ── what was paid, and when ──
  const deliveredAt = statement.periodTo && statement.periodTo.getTime() < at.getTime() ? statement.periodTo : at;
  const shippedAt = y.shippedAt ?? x.shippedAt ?? null;
  const split = splitBox(inPackingOrder(y.items), p.pieces);
  const wholeBox = p.pieces === boxTotal;

  // ── 1. the requests that were asking something of these parcels are answered ──
  let closedRequests = 0;
  const carriedOut = await tx.orderChangeRequest.updateMany({
    where: { companyId: p.companyId, orderId: y.id, intent: 'CANCEL', status: 'PENDING' },
    data: {
      status: 'APPROVED', decidedById: p.user.id, decidedAt: at, decisionNote: 'نُفِّذ بتبديل الطرد',
      appliedAt: at, appliedById: p.user.id,
    },
  });
  closedRequests += carriedOut.count;
  for (const orderId of [y.id, x.id, ...(reusableReplacement(x) && x.replacedBy ? [x.replacedBy.id] : [])]) {
    const withdrawn = await tx.orderChangeRequest.updateMany({
      where: { companyId: p.companyId, orderId, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedById: p.user.id, decidedAt: at, decisionNote: 'أُغلق بتبديل الطرد' },
    });
    const answered = await tx.orderChangeRequest.updateMany({
      where: OPEN_REQUEST_WHERE(p.companyId, orderId),
      data: { appliedAt: at, appliedById: p.user.id },
    });
    closedRequests += withdrawn.count + answered.count;
  }

  // ── 2. Y: its box went to another customer ──
  const yWas = y.shippingStatus;
  const yCounted = await aDoorCountedIt(tx, p.companyId, y.id);
  const yEnded = await tx.order.updateMany({
    where: {
      id: y.id, companyId: p.companyId, version: y.version,
      shippingStatus: { in: [...IN_FLIGHT] }, settlementStatus: { not: 'SETTLED' },
    },
    data: wholeBox
      ? {
          shippingStatus: 'RETURNED', status: 'RETURNED', returnedAt: at,
          returnReason: 'CUSTOMER_REQUEST', settlementStatus: 'NOT_APPLICABLE', version: { increment: 1 },
        }
      : {
          // The pieces that did not go still come back: the desk expects exactly those.
          shippingStatus: 'RETURN_REQUESTED', returnReason: 'CUSTOMER_REQUEST',
          settlementStatus: 'CANCELLED', version: { increment: 1 },
        },
  });
  if (yEnded.count !== 1) return refuse(409, 'ORDER_MOVED', SWAP_WHY.moved);

  // Units, not lines: what was still held on the box before, less what is held now. Zero when a door had let it go.
  const heldBefore = y.items.reduce((sum, i) => sum + i.reservedQty, 0);
  let released = heldBefore;
  if (wholeBox) {
    await releaseOrderLines(tx, y.id);
  } else {
    for (const s of split) {
      await tx.orderItem.update({
        where: { id: s.id },
        data: { deliveredQty: s.taken, returnedQty: s.remaining, reservedQty: s.reserved },
      });
    }
    released = heldBefore - split.reduce((sum, s) => sum + s.reserved, 0);
  }
  const yEndedAs = wholeBox ? ('RETURNED' as const) : ('RETURN_REQUESTED' as const);

  // ── 3. X: the customer's own box is the one that goes back ──
  const xWas = x.shippingStatus;
  const xCounted = await aDoorCountedIt(tx, p.companyId, x.id);
  const xBecomes = stateGroup(xWas) === 'COMING_BACK' ? xWas : 'RETURN_REQUESTED';
  const xEnded = await tx.order.updateMany({
    where: {
      id: x.id, companyId: p.companyId, version: x.version,
      shippingStatus: { in: [...OWNER_STATES] }, settlementStatus: { not: 'SETTLED' },
    },
    data: {
      shippingStatus: xBecomes,
      ...(x.returnReason ? {} : { returnReason: 'WRONG_PRODUCT' }),
      version: { increment: 1 },
    },
  });
  if (xEnded.count !== 1) return refuse(409, 'ORDER_MOVED', SWAP_WHY.moved);

  // ── 4. X′: the sale ──
  const box = {
    fromOrderId: y.id,
    pieces: p.pieces,
    paid,
    fee,
    priceIncludesDelivery: x.priceIncludesDelivery === true,
    shippedAt,
    deliveredAt,
  };
  const reshaping = reusableReplacement(x) && x.replacedBy !== null;
  let made: ReplacementResult;
  try {
    made = reshaping
      ? await reshapeToBox(tx, {
          companyId: p.companyId,
          orderId: x.replacedBy!.id,
          expectedVersion: x.replacedBy!.version,
          minorUnit: p.minorUnit,
          allowNegativeStock: p.allowNegativeStock,
          deliveryProviderId: statement.deliveryProviderId,
          box,
          internalNote: `بديل ${x.orderNumber} صار هو البيعة: بضاعة الطلب ${y.orderNumber} سُلِّمت للزبون وانحصّل ثمنها`,
        })
      : await createReplacement(tx, {
          companyId: p.companyId,
          createdById: p.user.id,
          order: x as unknown as ReplacementSource,
          orderPrefix: p.orderPrefix,
          attempt: p.attempt,
          minorUnit: p.minorUnit,
          allowNegativeStock: p.allowNegativeStock,
          shippingStatus: 'DELIVERED',
          deliveryProviderId: statement.deliveryProviderId,
          internalNotes: `تبديل طرد عن ${x.orderNumber}: بضاعة الطلب ${y.orderNumber} سُلِّمت لهذا الزبون وانحصّل ثمنها`,
          box,
        });
  } catch (e) {
    if (e instanceof BoxOrderMoved) return refuse(409, 'ORDER_MOVED', SWAP_WHY.moved);
    if (e instanceof Error && e.message.startsWith('BOX_PRICE')) return refuse(409, 'PRICE_DRIFT', SWAP_WHY.priceDrift);
    throw e;
  }
  const saleTotal = made.cod ?? 0;
  const saleFee = made.fee ?? 0;

  // ── 5. the stock: the goods leave the shelf ONCE, on the sale ──
  const consumed = await consumeOrderStock(tx as never, {
    orderId: made.id,
    companyId: p.companyId,
    userId: p.user.id,
  });

  // ── 6. the customers' own counters, as differences against what the doors wrote ──
  await tx.customer.update({
    where: { id: x.customerId },
    data: { deliveredOrders: { increment: 1 }, totalPurchaseValue: { increment: paid } },
  });
  let refusalTakenBack = false;
  if (xCounted) {
    const back = await tx.customer.updateMany({
      where: { id: x.customerId, cancelledOrders: { gt: 0 } },
      data: { cancelledOrders: { decrement: 1 } },
    });
    refusalTakenBack = back.count === 1;
  }
  // Y's customer cancelled: a return that is already counted by a door is not counted twice.
  const boxCustomerCancelled = !yCounted && !['CANCELLED', 'REJECTED'].includes(y.confirmationStatus);
  if (boxCustomerCancelled) {
    await tx.customer.update({ where: { id: y.customerId }, data: { cancelledOrders: { increment: 1 } } });
  }

  // ── 7. the commission of the SALE: X's people, on what was collected, once (the ledger refuses a second) ──
  const accrual = await accrueForOrder(tx, { companyId: p.companyId, orderId: made.id, minorUnit: p.minorUnit });

  // ── 8. the lines ──
  const saleFacts = await tx.order.findFirst({
    where: { id: made.id, companyId: p.companyId },
    select: { id: true, settlementStatus: true, ...SETTLEMENT_ORDER_SELECT },
  });
  if (!saleFacts) return refuse(409, 'ORDER_MOVED', SWAP_WHY.moved);
  const clean = { claimedByAnotherLine: false, otherStatements: [], openRequests: [] as string[] };
  const verdict = judgeLine({ order: saleFacts, line, minorUnit: p.minorUnit, integrity: clean, openClaim: null });
  const linked = await tx.settlementMatch.updateMany({
    where: {
      id: match.id, statementId: p.statementId, orderId: y.id, result: 'MISMATCHED', resolution: null,
      statement: { approvedAt: null },
    },
    data: {
      orderId: made.id,
      result: verdict.result,
      matchedBy: MANUAL_MATCH,
      expectedAmount: verdict.expected,
      statementAmount: verdict.stated,
      difference: verdict.difference,
      expectedFee: verdict.expectedFee,
      statementFee: verdict.statedFee,
      feeDifference: verdict.feeDifference,
      note: lineNote(y.orderNumber, made.orderNumber),
    },
  });
  if (linked.count !== 1) return refuse(409, 'ORDER_MOVED', SWAP_WHY.moved);

  // X's own line, if the company wrote one: judged again, now against a parcel that is coming back.
  const ownerRows = await tx.settlementMatch.findMany({
    where: {
      companyId: p.companyId, statementId: p.statementId, orderId: x.id, resolution: null,
      result: 'MISMATCHED', statementLineId: { not: null },
    },
    select: { id: true, statementLine: { select: { amount: true, fee: true, status: true } } },
  });
  if (ownerRows.length > 0) {
    const ownerFacts = { ...x, shippingStatus: xBecomes };
    for (const row of ownerRows) {
      if (!row.statementLine) continue;
      const v = judgeLine({ order: ownerFacts, line: row.statementLine, minorUnit: p.minorUnit, integrity: clean, openClaim: null });
      await tx.settlementMatch.updateMany({
        where: { id: row.id, statementId: p.statementId, resolution: null, statement: { approvedAt: null } },
        data: {
          result: v.result,
          expectedAmount: v.expected,
          statementAmount: v.stated,
          difference: v.difference,
          expectedFee: v.expectedFee,
          statementFee: v.statedFee,
          feeDifference: v.feeDifference,
          note: v.note ?? `تبديل طرد: بضاعة الطلب ${y.orderNumber} سُلِّمت لزبون الطلب ${made.orderNumber}`,
        },
      });
    }
  }

  // ── 9. the receipt that closes Y when the whole box went ──
  if (wholeBox) {
    await tx.returnReceipt.create({
      data: {
        companyId: p.companyId,
        orderId: y.id,
        expectedQty: 0,
        receivedQty: 0,
        damagedQty: 0,
        missingQty: 0,
        courierFeeCharged: false,
        courierFeeAmount: 0,
        inspectedById: p.user.id,
        note: `بضاعته سُلِّمت لزبون ${made.orderNumber}`,
        stockRestored: false,
      },
    });
  }

  // ── 10. the story, written on all three, so none can be read without the others ──
  const who = p.user.name ?? null;
  const common = {
    statement: statement.reference,
    sale: made.orderNumber,
    owner: x.orderNumber,
    box: y.orderNumber,
    pieces: p.pieces,
    paid,
    fee,
  };
  const stories: Array<[string, string, string, string, Record<string, unknown>]> = [
    [x.id, SWAP_ACTION, `بضاعة الطلب ${y.orderNumber} سُلِّمت لزبونك وصدر البديل ${made.orderNumber}`,
      xBecomes, { ...common, role: ACTIVITY_ROLE.original, ownerBoxBack: p.ownerBoxBack }],
    [made.id, SWAP_ACTION, `بديل ${x.orderNumber}: بضاعة الطلب ${y.orderNumber} سُلِّمت وانحصّل ${paid}`,
      'DELIVERED', { ...common, role: ACTIVITY_ROLE.replacement }],
    [y.id, 'SWAP_BOX_GIVEN', `بضاعته سُلِّمت لزبون ${made.orderNumber} — ${p.pieces} من ${boxTotal} قطعة`,
      yEndedAs, { ...common, role: 'BOX', wholeBox }],
  ];
  for (const [orderId, action, body, newStatus, meta] of stories) {
    await tx.orderActivity.create({
      data: {
        companyId: p.companyId, orderId, userId: p.user.id, action, newStatus,
        metadata: JSON.stringify({ ...meta, by: who }),
      },
    });
    await tx.orderNote.create({
      data: { companyId: p.companyId, orderId, authorId: p.user.id, kind: 'internal', body },
    });
  }
  for (const [orderId, from, to] of [
    [y.id, yWas, yEndedAs],
    [x.id, xWas, xBecomes],
  ] as const) {
    if (from === to) continue;
    await tx.orderStatusLog.create({
      data: {
        companyId: p.companyId, orderId, statusType: 'SHIPPING', previousValue: from, newValue: to,
        changedById: p.user.id, changedByRole: p.user.role, note: 'تبديل طرد على سطر كشف',
      },
    });
  }
  await tx.orderStatusLog.create({
    data: {
      companyId: p.companyId, orderId: made.id, statusType: 'SHIPPING', previousValue: null, newValue: 'DELIVERED',
      changedById: p.user.id, changedByRole: p.user.role, note: 'تبديل طرد على سطر كشف',
    },
  });

  return {
    reference: statement.reference,
    line: { matchId: match.id, result: verdict.result, expected: verdict.expected, stated: verdict.stated },
    sale: { id: made.id, orderNumber: made.orderNumber, total: saleTotal, fee: saleFee, currency: x.currency, reshaped: reshaping },
    owner: { id: x.id, orderNumber: x.orderNumber, boxBack: p.ownerBoxBack },
    box: { id: y.id, orderNumber: y.orderNumber, endedAs: yEndedAs, pieces: p.pieces, total: boxTotal },
    boxRow: y,
    stock: { released, consumed: consumed.taken },
    counters: { customerDelivered: 1, customerRefusalTakenBack: refusalTakenBack, boxCustomerCancelled },
    commission: { created: accrual.created, amount: accrual.amount ?? null },
    closedRequests,
  };
}

/* ───────────────────────────── the search ───────────────────────────── */

export interface SwapCandidate {
  id: string;
  orderNumber: string;
  customer: { id: string; fullName: string; phone: string } | null;
  shippingStatus: string;
  /** What the courier owes for it by the one rule — the line's amount is the clue to the right one. */
  expected: number | null;
  /** Why the rules would refuse it, in Arabic. Empty means a person may pick it. */
  blockedBy: string[];
}

export interface SwapSearch {
  box: { orderNumber: string; pieces: number; products: string[]; blockedBy: string[] };
  candidates: SwapCandidate[];
  hint: string | null;
}

/** Fewer characters than this would list half the shop. */
export const SWAP_MIN_QUERY = 3;
export const SWAP_CANDIDATE_LIMIT = 20;

/**
 * THE ORDERS THAT MIGHT HAVE TAKEN THE BOX — by the customer's phone, our order number or the waybill.
 *
 * Scope is fixed here, never taken from the request: this company, this statement's store and courier, the
 * orders on the road or coming back. Each is checked against the same blockers the door uses, so a row that
 * would be refused is greyed with the sentence, not discovered by pressing.
 */
export async function findSwapCandidates(
  tx: Prisma.TransactionClient,
  p: { companyId: string; storeId: string; statementId: string; matchId: string; query: string; minorUnit: number }
): Promise<SwapSearch> {
  const statement = await tx.courierStatement.findFirst({
    where: { id: p.statementId, companyId: p.companyId, storeId: p.storeId },
    select: { id: true, storeId: true, currencyCode: true, deliveryProviderId: true },
  });
  if (!statement) return refuse(404, 'NOT_FOUND', SWAP_WHY.notFound);
  const match = await tx.settlementMatch.findFirst({
    where: { id: p.matchId, statementId: p.statementId, companyId: p.companyId },
    select: { id: true, result: true, orderId: true, matchedBy: true, resolution: true },
  });
  if (!match) return refuse(404, 'NOT_FOUND', SWAP_WHY.notFound);
  if (match.result !== 'MISMATCHED' || !match.orderId || match.matchedBy === MANUAL_MATCH || match.resolution) {
    return refuse(409, 'NOT_SWAPPABLE', SWAP_WHY.notAMoneyLine);
  }
  const y = await tx.order.findFirst({ where: { id: match.orderId, companyId: p.companyId }, select: SWAP_ORDER_SELECT });
  if (!y) return refuse(404, 'ORDER_NOT_FOUND', SWAP_WHY.orderNotFound);

  const ctx = await contextOf(tx, { companyId: p.companyId, y, statement });
  const box = {
    orderNumber: y.orderNumber,
    pieces: boxUnits(y.items),
    products: [...new Set(y.items.map((i) => i.productName))],
    blockedBy: boxBlockers(y, ctx).map((b) => b.error),
  };

  const query = p.query.trim();
  if (query.length < SWAP_MIN_QUERY) {
    return { box, candidates: [], hint: `اكتب ${SWAP_MIN_QUERY} خانات على الأقل: هاتف الزبون، أو رقم طلبه` };
  }

  const rows = await tx.order.findMany({
    where: {
      companyId: p.companyId,
      storeId: p.storeId,
      deliveryProviderId: statement.deliveryProviderId,
      id: { not: y.id },
      shippingStatus: { in: [...OWNER_STATES] },
      settlementStatus: { not: 'SETTLED' },
      OR: orderSearchOr(query),
    } as Prisma.OrderWhereInput,
    select: SWAP_ORDER_SELECT,
    orderBy: { createdAt: 'desc' },
    take: SWAP_CANDIDATE_LIMIT,
  });
  const held = rows.length
    ? await tx.settlementMatch.findMany({
        where: { companyId: p.companyId, orderId: { in: rows.map((r) => r.id) }, statementLineId: { not: null }, OR: claimingRowWhere() },
        select: { orderId: true },
      })
    : [];
  const claimed = rows.length
    ? await tx.settlementMatch.findMany({
        where: { companyId: p.companyId, orderId: { in: rows.map((r) => r.id) }, resolution: 'OURS_STANDS' },
        select: { orderId: true },
      })
    : [];
  const claimIds = new Set(claimed.map((h) => h.orderId));
  const heldIds = new Set(held.map((h) => h.orderId));

  const candidates = rows.map((o): SwapCandidate => {
    let expected: number | null = null;
    try {
      expected = expectedAmountFor(o, p.minorUnit);
    } catch {
      expected = null;
    }
    const blockedBy = ownerBlockers(o, y, ctx).map((b) => b.error);
    if (heldIds.has(o.id)) blockedBy.push(SWAP_WHY.claimedElsewhere);
    if (claimIds.has(o.id)) blockedBy.push(SWAP_WHY.openClaim);
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      customer: o.customer,
      shippingStatus: o.shippingStatus,
      expected,
      blockedBy,
    };
  });
  return { box, candidates, hint: candidates.length === 0 ? 'لا طلب في الطريق بهذا البحث لشركة هذا الكشف' : null };
}
