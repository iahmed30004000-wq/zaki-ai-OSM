import { db } from '../db';
import { readLineRoleOrder } from './parser';
import { typed } from '../text-search';

/**
 * THE ORDER THIS REFERENCE ALREADY MADE (T4).
 *
 * Line 1 alone is not trusted: it may number a page of his sheet rather than an order. Line 1 AND line 2 together — the
 * same reference at the same second — is the same order posted twice, and the second one must not become a second
 * parcel and a second collection.
 *
 * Read from this store's PROCESSED messages of the last seven days whose text holds line 2, then each of them is read
 * again with the same reader, so the key is compared exactly as the door read it. Nothing is dropped, no index is added,
 * and `Order.externalRef` (the systems door's) is not touched.
 *
 * What it cannot see: an order staff typed by hand, and two copies that arrive in the same second (both find nothing
 * processed yet). The second is closed one step later by the message link inside the order's transaction.
 */
const TWIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function findTwinOrder(input: {
  companyId: string;
  storeId: string;
  /** The message being judged — never its own twin. */
  messageRowId: string;
  /** When it reached us: the window is counted back from here, so a retry later gets the same answer. */
  receivedAt: Date;
  ref: string;
  orderedAt: string;
}): Promise<{ id: string; orderNumber: string } | null> {
  // Line 2 as the reader gives it (Latin digits), and as an Arabic keypad would have typed the same date.
  const latin = input.orderedAt;
  const keypad = latin.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const candidates = await db.telegramMessage.findMany({
    where: {
      companyId: input.companyId,
      id: { not: input.messageRowId },
      processingStatus: 'PROCESSED',
      orderId: { not: null },
      createdAt: { gte: new Date(input.receivedAt.getTime() - TWIN_WINDOW_MS) },
      source: { storeId: input.storeId },
      OR: [...new Set([latin, keypad])].map((needle) => ({ text: typed(needle) })),
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { text: true, order: { select: { id: true, orderNumber: true } } },
  });
  for (const candidate of candidates) {
    const earlier = readLineRoleOrder(candidate.text ?? '');
    if (!earlier.claimed || !candidate.order) continue;
    if (earlier.lines.ref === input.ref && earlier.lines.orderedAt === input.orderedAt) return candidate.order;
  }
  return null;
}
