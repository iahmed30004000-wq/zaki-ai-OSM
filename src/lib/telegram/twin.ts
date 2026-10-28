import { db } from '../db';
import { normalizePhoneNumber } from '../phone';
import { readLabeledOrder } from './labeled-order';
import { typed } from '../text-search';

/**
 * THE ORDER THIS CUSTOMER ALREADY MADE AT THIS TIME FOR THIS PRODUCT.
 *
 * There is no order number any more (the owner: «تجاهل رقم الطلب»), so a message is the same order posted twice when
 * three things agree: «تاريخ الطلب» (the order's time at the source, to the second), the customer's phone (as the store
 * stores it, so «0932323642» and «+963 932 323 642» are one number) and the product it resolved to. The second copy must
 * not become a second parcel and a second collection.
 *
 * Read from this store's PROCESSED messages of the last seven days whose text holds the date, then each of them is read
 * again with the same reader, so the key is compared exactly as the door read it. Nothing is dropped, no index is added.
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
  /** «تاريخ الطلب» as the reader gives it (Latin digits). */
  orderedAt: string;
  /** «رقم الهاتف» as written. */
  phone: string;
  /** The store's country: a foreign number keeps its own code when it is normalised. */
  countryCode: string;
  /** The product the message resolved to. Absent when the caller only wants to show the order (the screen). */
  productId?: string;
}): Promise<{ id: string; orderNumber: string } | null> {
  // The date as the reader gives it (Latin digits), and as an Arabic keypad would have typed the same date.
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
    select: { text: true, order: { select: { id: true, orderNumber: true, productId: true } } },
  });
  const phone = normalizePhoneNumber(input.phone, input.countryCode);
  for (const candidate of candidates) {
    const earlier = readLabeledOrder(candidate.text ?? '');
    if (!earlier.claimed || !earlier.ok || !candidate.order) continue;
    if (earlier.fields.orderedAt !== input.orderedAt) continue;
    if (normalizePhoneNumber(earlier.fields.phone, input.countryCode) !== phone) continue;
    if (input.productId && candidate.order.productId !== input.productId) continue;
    return { id: candidate.order.id, orderNumber: candidate.order.orderNumber };
  }
  return null;
}
