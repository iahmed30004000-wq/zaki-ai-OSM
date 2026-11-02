import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { notHandedToCourierWhere } from './order-seal';
import { TWIN_CONFIRMED_CODE, twinConfirmedSentence, type ConfirmedTwinView } from './twin-refusal';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * THE SAME CUSTOMER, THE SAME PRODUCT, ALREADY CONFIRMED — THE LAST QUESTION BEFORE A SECOND «نعم».
 *
 * THE CASE (the owner, 2/11): «الزبون بعت طلبو 3 مرات، عندي 3 بنات تأكيد، كل طلب سحبتو بنت مختلفة، بنزلو 3 طلبات مؤكدة». The
 * advisory flag (`recent-twin-order.ts`) tells the person on the phone about a twin raised minutes before — a notice above the
 * buttons, written once on the later order, for ten minutes, refusing nothing. Three agents who each hold their own copy never
 * read it as an instruction, and nothing at the confirm door ever looked at what the OTHER two were doing. So all three said yes.
 *
 * This is the door's own check. When an agent confirms an order, and the same customer already has a CONFIRMED order for the
 * same product that the courier has not taken, the confirmation is refused with `TWIN_CONFIRMED` and the screen asks her what
 * it is: a duplicate (reject it, the existing reason) or a second order on purpose (confirm again, with `acknowledgeTwin`).
 * The flag is untouched and still tells the first agent what it always told her; this stops the second yes.
 *
 * ── WHAT A TWIN IS ──
 *
 * Another order of the SAME company, store and customer (the customer row is per company, store and phone and holds one
 * person across the spellings of a number, so «same phone» is `customerId`), that is:
 *   · CONFIRMED — a yes that stands. Not new, not in progress, not postponed, not refused, not cancelled;
 *   · STILL OURS — the courier has not taken it (`notHandedToCourierWhere`, the owner's line of 28/10: until the press of
 *     «إغلاق الشحنة — سُلّمت للشركة» an order can still be cancelled or held, so it is still a thing a person can decide about;
 *     after it, the parcel is the company's and a new order for the same product is the customer asking again);
 *   · not a replacement or a win-back (`replacesOrderId` empty): the repeat is the point of those;
 *   · created in the last `TWIN_CONFIRM_WINDOW_HOURS` hours;
 *   · carrying at least one product the order being confirmed carries — the head product or any line, on either side.
 * If the order being confirmed is itself a replacement or a win-back, the guard does not apply to it.
 *
 * ── THE LOCK — WHY IT IS NOT ENOUGH TO LOOK ──
 *
 * Two agents pressing «تأكيد» on two twins in the same second each look for a confirmed twin, find none (neither has
 * committed), and both confirm. Looking is a read followed by a write, and between the two a second transaction can ask
 * the same question and get the same answer — the shape `reserveOrderLines` solves for stock. So the first statements of the
 * confirming transaction take a per-customer advisory lock (`pg_advisory_xact_lock`, released by Postgres at commit or
 * rollback), THEN read. The second agent waits at the lock; when it opens she reads the first's committed yes (every
 * transaction here runs at READ COMMITTED, so the statement after the lock sees what was committed before it was granted)
 * and is refused. `$executeRaw` and not `$queryRaw`, as the two other lock sites in this repository do: the function
 * returns `void`, and a result Prisma cannot deserialize would turn every confirmation into a 500.
 *
 * WHAT A UNIT TEST CAN AND CANNOT SAY ABOUT IT: that the lock is the first statement, that the read follows it and the write
 * follows the read, and — against a model of READ COMMITTED with a real mutex per lock key — that two confirmations launched
 * together end with one yes. It cannot say that Postgres grants the lock the way the model does; that is Postgres's contract.
 */
export const TWIN_CONFIRM_WINDOW_HOURS = 72;

/** How many twins are named at most: a customer who sent it fifty times needs a refusal, not fifty numbers. */
export const MAX_TWINS_NAMED = 5;

/** The history row written when she confirmed past the refusal. The timeline names it in Arabic (`order-timeline.ts`). */
export const TWIN_CONFIRM_ACK_ACTION = 'TWIN_CONFIRM_ACKNOWLEDGED';

const HOUR_MS = 60 * 60 * 1000;

/** A confirmed twin, as read: a number, a time, a colleague. Nothing about the customer, and no id. */
export interface ConfirmedTwin {
  orderNumber: string;
  confirmedAt: Date | null;
  confirmedByName: string | null;
}

export interface TwinSubject {
  /** The order being confirmed — never its own twin. */
  id: string;
  customerId: string;
  /** Every product it carries: the head's and each line's. */
  productIds: readonly string[];
  /** Set on a replacement or a win-back: the guard does not apply. */
  replacesOrderId: string | null;
}

/**
 * «THE SAME PRODUCT» — the head product OR any line's product, `null` when there is nothing to compare.
 *
 * The reading `findRecentTwins` has (`recent-twin-order.ts`): a basket whose second line repeats yesterday's product is a
 * repeat. It is written here again rather than imported because the flag's file is not to be touched by this work; the
 * two are held to each other by `a-confirmed-twin-stops-the-second-yes.test.ts`, which asks both for their clause and
 * requires them equal — so a change to one that forgets the other turns that test red instead of drifting.
 */
export function sameProductWhere(productIds: readonly string[]): Prisma.OrderWhereInput | null {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return null;
  return { OR: [{ productId: { in: ids } }, { items: { some: { productId: { in: ids } } } }] };
}

/**
 * The confirmed twins of an order, newest yes first, at most `MAX_TWINS_NAMED`. Empty when there are none.
 *
 * Takes the client it is given — the confirming transaction's — and asks it ONE thing. It selects a number, a time and the
 * confirming colleague's name, so nothing about the customer can leave through it.
 */
export async function findConfirmedTwins(
  client: Tx,
  q: { companyId: string; storeId: string | null; order: TwinSubject; now: Date }
): Promise<ConfirmedTwin[]> {
  // A replacement or a win-back is a repeat on purpose.
  if (q.order.replacesOrderId) return [];
  const sameProduct = sameProductWhere(q.order.productIds);
  if (!sameProduct) return [];

  const rows = await client.order.findMany({
    where: {
      companyId: q.companyId,
      storeId: q.storeId,
      customerId: q.order.customerId,
      id: { not: q.order.id },
      confirmationStatus: 'CONFIRMED',
      replacesOrderId: null,
      createdAt: { gte: new Date(q.now.getTime() - TWIN_CONFIRM_WINDOW_HOURS * HOUR_MS) },
      AND: [notHandedToCourierWhere(), sameProduct],
    },
    // The newest yes first; an order whose yes carries no time sorts after the ones that do.
    orderBy: [{ confirmedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: MAX_TWINS_NAMED,
    select: { orderNumber: true, confirmedAt: true, confirmer: { select: { name: true } } },
  });

  return rows.map((r) => ({
    orderNumber: r.orderNumber,
    confirmedAt: r.confirmedAt,
    confirmedByName: r.confirmer?.name ?? null,
  }));
}

/**
 * THE GUARD, AS THE CONFIRMING TRANSACTION RUNS IT: the lock first, then the order's own lines, then the twins.
 *
 * Call it as the FIRST thing inside the transaction that writes the yes, with the transaction's client. Handed the root
 * client the lock would be taken and dropped in the same breath; the only caller is the confirmation door, which calls it
 * inside `db.$transaction`, and `a-confirmed-twin-stops-the-second-yes.test.ts` reads the door to keep it there.
 *
 * Returns the twins; an empty list means «go ahead». Deciding what to do with a non-empty one — refuse, or record that she
 * knew and go on — is the door's.
 */
export async function guardConfirmAgainstTwins(
  tx: Tx,
  q: {
    companyId: string;
    order: { id: string; customerId: string; productId: string; storeId: string | null; replacesOrderId: string | null };
    now: Date;
  }
): Promise<ConfirmedTwin[]> {
  // A replacement or a win-back repeats on purpose: no lock, no read.
  if (q.order.replacesOrderId) return [];

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`twin:${q.order.customerId}`}::text, 0))`;

  // Read AFTER the lock: the order's lines are part of the question, and so is everything the holder of the lock just committed.
  const lines = await tx.orderItem.findMany({ where: { orderId: q.order.id }, select: { productId: true } });
  return findConfirmedTwins(tx, {
    companyId: q.companyId,
    storeId: q.order.storeId ?? null,
    order: {
      id: q.order.id,
      customerId: q.order.customerId,
      productIds: [q.order.productId, ...lines.map((l) => l.productId)],
      replacesOrderId: null,
    },
    now: q.now,
  });
}

/** She confirmed past the refusal: one history row, in her name, naming the orders she was told about. */
export async function recordTwinAcknowledged(
  tx: Tx,
  q: { companyId: string; orderId: string; userId: string; twins: ConfirmedTwin[] }
): Promise<void> {
  await tx.orderActivity.create({
    data: {
      companyId: q.companyId,
      orderId: q.orderId,
      userId: q.userId,
      action: TWIN_CONFIRM_ACK_ACTION,
      metadata: JSON.stringify({ twins: q.twins.map((t) => t.orderNumber) }),
    },
  });
}

/**
 * THROWN INSIDE THE TRANSACTION, ANSWERED OUTSIDE IT.
 *
 * Aborts the transaction (nothing was written — the guard only reads) and carries the twins to the door's `catch`, which
 * answers 409. A sentinel class and not a message prefix: it cannot be confused with anything else the transaction throws,
 * and it can never reach the generic handler, which would turn it into a 500.
 */
export class TwinConfirmedRefusal extends Error {
  constructor(readonly twins: ConfirmedTwin[]) {
    super(TWIN_CONFIRMED_CODE);
    this.name = 'TwinConfirmedRefusal';
  }
}

/** The 409's body. `error` and `errorAr` are the one sentence; `twins` carries numbers, times and colleagues only. */
export function twinConfirmedBody(twins: ConfirmedTwin[]): {
  error: string;
  errorAr: string;
  code: typeof TWIN_CONFIRMED_CODE;
  twins: ConfirmedTwinView[];
} {
  const sentence = twinConfirmedSentence(twins.map((t) => t.orderNumber));
  return {
    error: sentence,
    errorAr: sentence,
    code: TWIN_CONFIRMED_CODE,
    twins: twins.map((t) => ({
      orderNumber: t.orderNumber,
      confirmedAt: t.confirmedAt ? t.confirmedAt.toISOString() : null,
      confirmedByName: t.confirmedByName,
    })),
  };
}
