import type { Prisma } from '@prisma/client';
import { db } from './db';
import { CONFIRMATION_REFUSED } from './order-state';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * THE SAME CUSTOMER, THE SAME PRODUCT, A FEW MINUTES APART — A FLAG, NEVER A REFUSAL.
 *
 * The owner asked for a detector of the duplicate, the fake and the rapid order (Q35, WR#9, RV25). Three guards already
 * exist and none of them is this one:
 *
 *   · the blacklist REFUSES a phone somebody put on the list (`blacklist.ts`, checked at every door);
 *   · the storefront door REFUSES a second submission of the same phone within five minutes (an in-memory limiter);
 *   · the Telegram door HOLDS a message whose date, phone and product match one it already turned into an order.
 *
 * What nobody did: look at the order that was just written and say «هذا العميل طلب نفس المنتج قبل دقائق», at the
 * doors that take a person's word for it — the order form, the AI intake, the systems door — and at the two above
 * once they let it through. A true repeat order is ordinary (a customer who adds a second bottle by phone), so this
 * REFUSES NOTHING and CHANGES NO NUMBER: it writes one history row on the new order, and the confirmation window
 * draws it above the buttons so the person on the phone asks the question out loud.
 *
 * ── ONE FUNCTION, CALLED AFTER THE ORDER IS SAVED ──
 *
 * Every door that raises an order for a customer calls `flagRecentTwins` once, after its transaction committed. After,
 * and with its own `try`, because an advisory note must never be the reason an order the customer already thinks they
 * placed is lost — and a failing query INSIDE a transaction aborts the whole transaction in Postgres, which is exactly
 * how a note would take the order down with it.
 *
 * The doors that do NOT call it, and why (the guard names them so a new one has to choose):
 *   · replacement and win-back orders — the customer's repeat is the point of them, and they carry `replacesOrderId`;
 *   · the old-order migration — dated history, not a customer typing now.
 *
 * ── WHAT «THE SAME» MEANS ──
 *
 * The customer row is already per (company, store, phone) and holds one person across the spellings of a number
 * (`customer-identity.ts`), so «same phone» is «same `customerId`» and is not re-derived here. «Same product» is the
 * order's head product OR any line's product — a basket whose second line repeats yesterday's product is a repeat.
 * An order that was refused or cancelled is not a twin: asking again after a «لا» is the ordinary way to buy.
 */
export const TWIN_WINDOW_MS = 10 * 60 * 1000;

/** The history row's action. The timeline names it in Arabic (`order-timeline.ts`). */
export const TWIN_ACTION = 'DUPLICATE_SUSPECT';

/** How many twins are named at most: a customer ringing the shop fifty times needs a count, not fifty numbers. */
const MAX_NAMED = 5;

export interface Twin {
  id: string;
  orderNumber: string;
}

export interface TwinQuery {
  companyId: string;
  /** The order that was just saved — never its own twin. */
  orderId: string;
  customerId: string;
  /** Every product the new order carries: the head's and each line's. */
  productIds: string[];
  /** When the new order was written. The window is counted back from it, so a late retry gets the same answer. */
  at: Date;
}

/** The orders this customer raised for any of these products in the ten minutes before `at`. Empty when there is none. */
export async function findRecentTwins(client: Tx, q: TwinQuery): Promise<Twin[]> {
  const productIds = [...new Set(q.productIds.filter(Boolean))];
  if (productIds.length === 0) return [];
  // A row without a usable time (a caller that handed back a partial row) is judged from now, not thrown at.
  const at = q.at instanceof Date && !Number.isNaN(q.at.getTime()) ? q.at : new Date();
  return client.order.findMany({
    where: {
      companyId: q.companyId,
      customerId: q.customerId,
      id: { not: q.orderId },
      createdAt: { gte: new Date(at.getTime() - TWIN_WINDOW_MS), lte: at },
      // Asking again after a refusal is not a duplicate.
      confirmationStatus: { notIn: [...CONFIRMATION_REFUSED] },
      // A replacement or a win-back is a repeat on purpose.
      replacesOrderId: null,
      OR: [{ productId: { in: productIds } }, { items: { some: { productId: { in: productIds } } } }],
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_NAMED,
    select: { id: true, orderNumber: true },
  });
}

/**
 * Looks for the twins of a saved order and, when there are any, writes the flag on the NEW order's history. Returns
 * the twins it found. NEVER THROWS and never touches the order, its lines, its price or its stock.
 */
export async function flagRecentTwins(
  client: Tx,
  q: TwinQuery & { userId?: string | null }
): Promise<Twin[]> {
  try {
    const twins = await findRecentTwins(client, q);
    if (twins.length === 0) return [];
    await client.orderActivity.create({
      data: {
        companyId: q.companyId,
        orderId: q.orderId,
        userId: q.userId ?? null,
        action: TWIN_ACTION,
        metadata: JSON.stringify({
          windowMinutes: TWIN_WINDOW_MS / 60_000,
          twins: twins.map((t) => ({ id: t.id, orderNumber: t.orderNumber })),
        }),
      },
    });
    return twins;
  } catch (e) {
    // The order is saved; the note is advice. Say that something went wrong, never what the customer typed.
    console.error('[orders] twin flag failed:', (e as Error)?.name || 'unknown');
    return [];
  }
}

/** Reads the flag back from an activity row's metadata. Anything that is not a well-formed flag reads as none. */
export function twinsFromMetadata(metadata: string | null | undefined): Twin[] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata) as { twins?: unknown };
    if (!Array.isArray(parsed.twins)) return [];
    return parsed.twins
      .filter((t): t is Twin => !!t && typeof (t as Twin).id === 'string' && typeof (t as Twin).orderNumber === 'string')
      .map((t) => ({ id: t.id, orderNumber: t.orderNumber }));
  } catch {
    return [];
  }
}
