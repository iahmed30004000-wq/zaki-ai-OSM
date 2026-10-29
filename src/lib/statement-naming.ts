import type { Prisma } from '@prisma/client';
import type { db } from './db';
import type { LinkedLine, NamingLine } from './settlement-gates';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * WHICH STATEMENTS ALREADY SPEAK FOR THESE ORDERS — read once, for every door that must not book money twice.
 *
 * «استلمت منه» asks it before it takes cash, and the manual statement asks it before it takes an order into a
 * draft: an order a statement names is paid by that statement (now or when it is approved), so a second road to
 * the same money is refused. Two reads, both scoped to this company and this store:
 *
 *   · the LINES that carry the order's own reference, or the courier's barcode for it (judged by
 *     `statementNamingRefusal`, which also scopes a barcode to the courier that issued it);
 *   · the LINES A PERSON TIED to the order by hand («اربطه بطلب»), which carry neither of its references and are
 *     found through the match row that holds the link.
 *
 * `exceptStatementId` leaves one statement out — the draft a person is adding to, whose own lines are not a
 * reason to refuse the order a second time. Without it the reads are exactly what the collection door always
 * made.
 */
export async function readNamingLines(
  tx: Tx,
  p: {
    companyId: string;
    storeId: string;
    orders: { merchantRef?: string | null; trackingNumber?: string | null }[];
    exceptStatementId?: string;
  }
): Promise<NamingLine[]> {
  const refs = p.orders.map((o) => o.merchantRef).filter((r): r is string => !!r);
  const barcodes = p.orders.map((o) => o.trackingNumber).filter((b): b is string => !!b);
  if (refs.length + barcodes.length === 0) return [];
  return tx.statementLine.findMany({
    where: {
      statement: { companyId: p.companyId, storeId: p.storeId, ...(p.exceptStatementId ? { id: { not: p.exceptStatementId } } : {}) },
      OR: [
        ...(refs.length ? [{ merchantRef: { in: refs } }] : []),
        ...(barcodes.length ? [{ barcode: { in: barcodes } }] : []),
      ],
    },
    select: {
      merchantRef: true,
      barcode: true,
      statement: { select: { reference: true, status: true, approvedAt: true, deliveryProviderId: true } },
    },
  });
}

/** The lines a person tied to these orders by hand, on any statement (but the one left out). */
export function readTiedLines(
  tx: Tx,
  p: { companyId: string; orderIds: string[]; exceptStatementId?: string }
): Promise<LinkedLine[]> {
  return tx.settlementMatch.findMany({
    where: {
      companyId: p.companyId,
      orderId: { in: p.orderIds },
      statementLineId: { not: null },
      ...(p.exceptStatementId ? { statementId: { not: p.exceptStatementId } } : {}),
    },
    select: {
      orderId: true,
      statement: { select: { reference: true, status: true, approvedAt: true, deliveryProviderId: true } },
    },
  });
}
