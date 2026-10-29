import { Prisma } from '@prisma/client';
import type { db } from './db';
import { roundMinor } from './money';
import { expectedAmountFor, SETTLEMENT_ORDER_SELECT } from './settlement';
import { closedStatementRefusal, collectTotalRefusal, statementNamingRefusal } from './settlement-gates';
import { readNamingLines, readTiedLines } from './statement-naming';
import {
  DRAFT_REFERENCE,
  HAS_RECEIPT_SENTENCE,
  MANUAL_DRAFT_PREFIX,
  MANUAL_FILE_NAME,
  duplicateReferenceSentence,
  isManualDraftHash,
  isManualHash,
  manualAddRefusal,
  manualFileHash,
  newDraftHash,
  type ManualRefusalBody,
} from './manual-statement-rules';

type TxClient = Prisma.TransactionClient;
type Tx = TxClient | typeof db;

/**
 * THE MANUAL STATEMENT — «مطابق يدوي» and then «تجميع».
 *
 * For a company that sends no statement (or whose statement never arrived), the owner gathers the parcels its
 * courier handed over into ONE statement and approves it, instead of taking the cash order by order.
 *
 *   PRESS 1  `addOrdersToDraft` — the delivered orders of ONE courier join that courier's open draft. A line
 *            carries the order's reference and an amount (what the courier is expected to hand over, unless the
 *            person typed another), so a short handover is recorded per order and not blurred into a total.
 *   PRESS 2  `assembleDraft` — the person gives the statement its reference and a period; from then on it is an
 *            ordinary statement that takes the existing receipt (any wallet, any currency with its rate), the
 *            existing matching and the existing approval.
 *
 * ── IT WRITES NO MONEY ──
 *
 * Neither press moves a wallet, settles an order or pays a commission. Those happen at the approval, as for every
 * statement, and the approval re-runs the matching inside its own transaction (see the statement door), so what
 * it settles is what is true at that moment and not what was true when someone pressed «مطابقة».
 *
 * ── AND IT IS THE SAME STATEMENT ──
 *
 *   · it is matched by `runMatching`, which skips the «not mentioned» sweep for a manual statement (that sweep
 *     asks «what did the courier leave out», and a hand-gathered list has no courier file to leave things out of);
 *   · an order a statement already names is refused here with the sentences «استلمت منه» uses;
 *   · a total of zero or less is refused with «استلمت منه»'s own sentences (`collectTotalRefusal`).
 */

/** Postgres has ONE advisory-lock space; this domain keeps the manual statement's keys apart from the stock's. */
const MANUAL_LOCK_DOMAIN = 4723;

/** A stop that carries its own answer: the transaction rolls back and the route sends this. */
export class ManualRefused extends Error {
  constructor(readonly status: number, readonly body: ManualRefusalBody) {
    super(body.code);
  }
}

/**
 * ONE PERSON AT A TIME PER COURIER, until the transaction ends.
 *
 * Adding and gathering both decide «which draft is this courier's»; without one lock a double press makes two
 * drafts, and a press that lands while the draft is being gathered writes a line into a statement that is no
 * longer open. Handed the root client the lock would be taken and dropped in the same breath, so that is refused.
 */
async function lockCourier(tx: TxClient, p: { companyId: string; storeId: string; courierId: string }) {
  if ('$transaction' in tx) throw new Error('الكشف اليدوي يعمل داخل معاملة — قفل خارجها لا يحجز شيئاً');
  const key = `manual-statement:${p.companyId}:${p.storeId}:${p.courierId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANUAL_LOCK_DOMAIN}::int4, hashtext(${key})::int4)`;
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  merchantRef: true,
  trackingNumber: true,
  currency: true,
  settlementStatus: true,
  deliveryProviderId: true,
  deliveryProvider: { select: { id: true, name: true } },
  ...SETTLEMENT_ORDER_SELECT,
} as const satisfies Prisma.OrderSelect;

export interface ManualItem {
  orderId: string;
  /** What the courier handed over for this order. Omitted = what we expect, by the one settlement rule. */
  amount?: number;
}

export interface AddResult {
  statementId: string;
  courier: string;
  currencyCode: string;
  /** The draft was made by this press. */
  created: boolean;
  added: number;
  /** Orders already in the draft: pressing again changes nothing unless a new amount was typed. */
  updated: number;
  lines: number;
  total: number;
}

/** The sum of a statement's lines, rounded once by the currency's minor unit. */
async function totalOfLines(tx: Tx, statementId: string, minorUnit: number): Promise<{ lines: number; total: number }> {
  const rows = await tx.statementLine.findMany({ where: { statementId }, select: { amount: true } });
  return { lines: rows.length, total: roundMinor(rows.reduce((sum, r) => sum + Number(r.amount), 0), minorUnit) };
}

/**
 * PRESS 1 — add these delivered orders of one courier to that courier's open draft, making the draft if there is none.
 *
 * Refuses, in this order (the first thing wrong is the answer): an order that is not in this store; an order with
 * no courier, two couriers, an order not delivered, already settled, in another currency, with no reference
 * (`manualAddRefusal`); a draft that already took a receipt; an order another statement names.
 */
export async function addOrdersToDraft(
  tx: TxClient,
  p: {
    companyId: string;
    storeId: string;
    userId: string;
    currencyCode: string;
    minorUnit: number;
    items: ManualItem[];
  }
): Promise<AddResult> {
  // The same order twice in one press is one order: the last amount typed for it wins.
  const byOrder = new Map<string, ManualItem>();
  for (const item of p.items) byOrder.set(item.orderId, item);
  const items = [...byOrder.values()];
  const ids = items.map((i) => i.orderId).sort();

  const read = () => tx.order.findMany({ where: { id: { in: ids }, companyId: p.companyId, storeId: p.storeId }, select: ORDER_SELECT });
  const refuse = (orders: Awaited<ReturnType<typeof read>>) => {
    if (orders.length !== ids.length) {
      throw new ManualRefused(404, { code: 'ORDERS_NOT_FOUND', error: 'بعض الطلبات غير موجودة في هذا المتجر' });
    }
    const why = manualAddRefusal(orders, p.currencyCode);
    if (why) throw new ManualRefused(409, why);
  };

  // A first read tells which courier this is, so the lock can be taken; then the orders are read AGAIN under it,
  // because «استلمت منه» settles orders in its own transaction and a state read before the lock may be stale.
  const first = await read();
  refuse(first);
  const courierId = first[0].deliveryProviderId as string;
  const courierName = first[0].deliveryProvider?.name ?? '';

  await lockCourier(tx, { companyId: p.companyId, storeId: p.storeId, courierId });
  await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  const orders = await read();
  refuse(orders);

  const draft = await tx.courierStatement.findFirst({
    where: {
      companyId: p.companyId,
      storeId: p.storeId,
      deliveryProviderId: courierId,
      approvedAt: null,
      fileHash: { startsWith: MANUAL_DRAFT_PREFIX },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, _count: { select: { receipts: true } } },
  });
  if (draft && draft._count.receipts > 0) {
    throw new ManualRefused(409, { code: 'HAS_RECEIPT', error: HAS_RECEIPT_SENTENCE });
  }

  // An order another statement names is paid by that statement; the draft's own lines are not a reason to refuse.
  const refs = orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    merchantRef: o.merchantRef,
    trackingNumber: o.trackingNumber,
    deliveryProviderId: o.deliveryProviderId,
  }));
  const covered = statementNamingRefusal(
    refs,
    await readNamingLines(tx, { companyId: p.companyId, storeId: p.storeId, orders: refs, exceptStatementId: draft?.id }),
    await readTiedLines(tx, { companyId: p.companyId, orderIds: ids, exceptStatementId: draft?.id })
  );
  if (covered) throw new ManualRefused(409, covered);

  const statementId =
    draft?.id ??
    (
      await tx.courierStatement.create({
        data: {
          companyId: p.companyId,
          storeId: p.storeId,
          deliveryProviderId: courierId,
          reference: DRAFT_REFERENCE,
          totalAmount: 0,
          currencyCode: p.currencyCode,
          fileName: MANUAL_FILE_NAME,
          fileHash: newDraftHash(),
          uploadedById: p.userId,
        },
        select: { id: true },
      })
    ).id;

  const existing = await tx.statementLine.findMany({
    where: { statementId, merchantRef: { in: orders.map((o) => o.merchantRef as string) } },
    select: { id: true, merchantRef: true },
  });
  const lineOf = new Map(existing.map((l) => [l.merchantRef as string, l.id]));
  const typed = new Map(items.map((i) => [i.orderId, i.amount]));

  let added = 0;
  let updated = 0;
  for (const order of orders) {
    const fee = roundMinor(Number(order.deliveryFee ?? 0), p.minorUnit);
    const lineId = lineOf.get(order.merchantRef as string);
    const asked = typed.get(order.id);

    // Pressing again without typing an amount leaves the line as it is: a person's figure is not reset by a double click.
    if (lineId && asked === undefined) {
      updated += 1;
      continue;
    }

    let expected: number;
    try {
      expected = expectedAmountFor(order, p.minorUnit);
    } catch {
      throw new ManualRefused(409, { code: 'NO_LINES', error: `الطلب ${order.orderNumber} بلا أسطر — لا يُحسب مبلغه`, orders: [order.orderNumber] });
    }
    const amount = roundMinor(asked ?? expected, p.minorUnit);
    /*
     * THE LINE STATES THE FEE TOO, because the approval writes the GROSS onto the order (`amount + fee`). With no
     * fee on the line the order would be written net of its delivery fee and every later reading of it would
     * deduct the fee a second time. The fee stated is the order's own, so no fee difference is ever invented.
     */
    const data = { amount, fee, collected: roundMinor(amount + fee, p.minorUnit) };
    if (lineId) {
      await tx.statementLine.update({ where: { id: lineId }, data });
      updated += 1;
    } else {
      await tx.statementLine.create({ data: { statementId, merchantRef: order.merchantRef, barcode: null, ...data } });
      added += 1;
    }
  }

  const { lines, total } = await totalOfLines(tx, statementId, p.minorUnit);
  // The lines above are written under this one claim: an open statement, or none of them (the whole transaction rolls back).
  const open = await tx.courierStatement.updateMany({
    where: { id: statementId, companyId: p.companyId, approvedAt: null, status: { not: 'APPROVED' } },
    data: { totalAmount: total },
  });
  if (open.count !== 1) throw new ManualRefused(409, closedStatementRefusal());

  return { statementId, courier: courierName, currencyCode: p.currencyCode, created: !draft, added, updated, lines, total };
}

export interface AssembleResult {
  statementId: string;
  reference: string;
  courier: string;
  currencyCode: string;
  lines: number;
  total: number;
}

/**
 * PRESS 2 — give the draft its reference and period, and make it the statement the receipt and the approval take over.
 *
 * The reference becomes part of the file hash with the company and the courier, so it is unique PER COURIER: two
 * couriers may both have «كشف الأحد», and a courier cannot have it twice. Refuses a statement that is not an open
 * draft, one that took a receipt, a reference this courier already used, and a total of zero or less.
 */
export async function assembleDraft(
  tx: TxClient,
  p: {
    companyId: string;
    storeId: string;
    statementId: string;
    reference: string;
    periodFrom: Date | null;
    periodTo: Date | null;
    minorUnit: number;
  }
): Promise<AssembleResult> {
  const where = { id: p.statementId, companyId: p.companyId, storeId: p.storeId };
  const peek = await tx.courierStatement.findFirst({ where, select: { deliveryProviderId: true } });
  if (!peek) throw new ManualRefused(404, { code: 'NOT_FOUND', error: 'الكشف غير موجود' });

  await lockCourier(tx, { companyId: p.companyId, storeId: p.storeId, courierId: peek.deliveryProviderId });
  await tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${p.statementId} FOR UPDATE`;
  const statement = await tx.courierStatement.findFirst({
    where,
    select: {
      id: true, fileHash: true, approvedAt: true, status: true, currencyCode: true,
      _count: { select: { receipts: true } },
    },
  });
  if (!statement) throw new ManualRefused(404, { code: 'NOT_FOUND', error: 'الكشف غير موجود' });
  if (statement.approvedAt != null || statement.status === 'APPROVED') {
    throw new ManualRefused(409, closedStatementRefusal());
  }
  if (!isManualHash(statement.fileHash)) {
    throw new ManualRefused(409, { code: 'NOT_MANUAL', error: 'هذا كشف مستورد من ملف — التجميع لمسوّدة الكشف اليدوي فقط' });
  }
  if (!isManualDraftHash(statement.fileHash)) {
    throw new ManualRefused(409, { code: 'ALREADY_ASSEMBLED', error: 'هذا الكشف مجمَّع من قبل' });
  }
  if (statement._count.receipts > 0) {
    throw new ManualRefused(409, { code: 'HAS_RECEIPT', error: HAS_RECEIPT_SENTENCE });
  }

  // The relation to the company is on the order, not on the statement: the name is read by its own id.
  const courier = await tx.deliveryProvider.findFirst({ where: { id: peek.deliveryProviderId, companyId: p.companyId }, select: { name: true } });

  const { lines, total } = await totalOfLines(tx, statement.id, p.minorUnit);
  if (lines === 0) throw new ManualRefused(409, { code: 'NO_LINES', error: 'المسوّدة فارغة — أضف طلبات أولاً' });
  const noMoney = collectTotalRefusal({
    expected: total,
    owed: roundMinor(-total, p.minorUnit),
    currency: statement.currencyCode,
    count: lines,
  });
  if (noMoney) throw new ManualRefused(409, noMoney);

  const fileHash = manualFileHash({ companyId: p.companyId, courierId: peek.deliveryProviderId, reference: p.reference });
  const taken = await tx.courierStatement.findFirst({
    where: { companyId: p.companyId, fileHash, id: { not: statement.id } },
    select: { id: true },
  });
  if (taken) throw new ManualRefused(409, { code: 'DUPLICATE_REFERENCE', error: duplicateReferenceSentence(p.reference) });

  // The write says what the reads above said: still the same draft, still no receipt. Only then is it gathered.
  const claimed = await tx.courierStatement.updateMany({
    where: { ...where, approvedAt: null, fileHash: statement.fileHash, receipts: { none: {} } },
    data: {
      reference: p.reference.trim(),
      fileHash,
      fileName: MANUAL_FILE_NAME,
      periodFrom: p.periodFrom,
      periodTo: p.periodTo,
      totalAmount: total,
    },
  });
  if (claimed.count !== 1) {
    throw new ManualRefused(409, { code: 'CHANGED', error: 'تغيّر الكشف قبل لحظات — حدّث الصفحة وأعد المحاولة' });
  }

  return {
    statementId: statement.id,
    reference: p.reference.trim(),
    courier: courier?.name ?? '',
    currencyCode: statement.currencyCode,
    lines,
    total,
  };
}
