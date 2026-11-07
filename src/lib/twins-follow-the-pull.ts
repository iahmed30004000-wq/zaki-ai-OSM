import type { Prisma } from '@prisma/client';
import type { db } from './db';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * ONE CUSTOMER, ONE AGENT — HIS OTHER ORDERS FOLLOW THE ONE SHE PULLED.
 *
 * THE CASE (the owner, 2/11): «فرض الزبون غبي بعت طلبو 3 مرات، عندي 3 بنات تأكيد، كل طلب سحبتو بنت مختلفة، بنزلو 3 طلبات مؤكدة.
 * زبون غبي تاني طلب من ماسنجر ومن السايت كمان بنتين بسحبو». The confirm guard (#165, `confirmed-twin.ts`) stops the second «نعم»;
 * this stops the second and third agent from ever ringing the same customer: the moment one of his orders is pulled, his other
 * orders that are still waiting and nobody has taken are HELD for her — the same hold a returning customer's order gets
 * (`order-reservation.ts`: `assignedToId` + `assignedAt`, twenty-four hours, let go when her account is off). Her colleagues see
 * them with her name and cannot pull them; «اسحب التالي» gives them to her first.
 *
 * ── WHICH ORDERS ARE HELD ──
 *
 * Another order of the SAME company, store and customer (`customerId` — one person across the spellings of his number) that the
 * hold itself can carry, nothing wider:
 *   · NEW, never claimed (`claimHistory: none`), nobody holds it and nobody is named for it (`claimedById` and `assignedToId`
 *     empty), not shipping. `reservedWhere` reads exactly these, so an order written here IS held — and an order that was ever
 *     worked, or that is decided (CONFIRMED · REJECTED · CANCELLED), or postponed, is never touched: NEW is inside #160's open
 *     list and is the only status a hold has;
 *   · not a win-back offer (`replacesOrderId` empty) — «held by nobody: whoever is free calls it», as `reserveReturningCustomers`
 *     already leaves it;
 *   · held for nobody else: a returning customer's order already named for his old agent stays hers (`assignedToId: null`), so
 *     the returning rule wins wherever it already spoke, and nothing it writes is changed.
 *
 * ── THE CAP ──
 *
 * `CLAIM_CAPS.total` (500) counts what is in her hands AND what is held for her (`capLoad` in `confirmation-queue.ts` — RV706,
 * the owner 3/11). So holding never names her for more than the cap: the caller passes the room left after this pull
 * (`capRoom` before it, minus one when the pulled order came from the pool — none when it was already held for her), and no more
 * than that is held. At the cap, nothing is held and his other orders stay in the shared queue (the confirm guard is then the net).
 *
 * ── THE LOCK ──
 *
 * Three agents pressing «اسحب» in the same second all pick his oldest order; one claims it and the other two wait on that row
 * until she commits, by which time his other orders are held for her — the row did the serialising. But the picks do not always
 * agree: one agent is given HIS order held for her («اسحب التالي» gives hers first) while a colleague takes his day-old order at
 * the head of the queue. Two different rows, nothing to wait on, and her hold of the old order comes AFTER her own claim — so the
 * colleague's claim lands first and he is split between them. The pull therefore takes a per-customer advisory lock
 * (`pg_advisory_xact_lock`, released by Postgres at commit or rollback) BEFORE its claim, whatever it picked: the second agent
 * waits at the lock until the first has claimed AND held his other orders and committed; her claim then misses (the order is held
 * for the first — `notHeldForOthersWhere` is asked at the write), and her next pick gives her somebody else's order.
 * `$executeRaw`, as `confirmed-twin.ts`, `reservation.ts` and `manual-statement.ts` take theirs: the function returns `void`. Its
 * own key space (`pull:`), so a pull never waits for a confirmation.
 *
 * A pull that waited at one customer's lock and then missed moves on still holding it (an xact lock cannot be let go early), and
 * may take a second customer's. Two such pulls crossing two customers in opposite order are a deadlock, which Postgres detects and
 * ends by failing one of them — she presses again. It needs both to have missed, and each then to be given an order of the OTHER's
 * customer that the hold could not carry (one worked before, given back): rare, and said in BACKLOG RV702.
 */

/** At most this many of his orders are held in one pull, whatever the room: a pull is one transaction, kept short. */
export const MAX_TWINS_HELD = 50;

/** The history row written on each order held this way. The timeline names it in Arabic (`order-timeline.ts`). */
export const TWIN_HELD_ACTION = 'HELD_WITH_HIS_OTHER_ORDER';

/** The lock key, apart from the confirm guard's `twin:` so a pull and a confirmation never wait for each other. */
export function pullLockKey(customerId: string): string {
  return `pull:${customerId}`;
}

/** Taken as the first thing the pull does about a customer, inside the pull's transaction, before its claim. */
export async function lockCustomerForPull(tx: Tx, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${pullLockKey(customerId)}::text, 0))`;
}

/** His other orders that may be held for her — see the header for every clause. */
export function twinsToHoldWhere(
  scope: { companyId: string; storeId: string },
  customerId: string,
  pulledOrderId: string
) {
  return {
    companyId: scope.companyId,
    storeId: scope.storeId,
    customerId,
    id: { not: pulledOrderId },
    claimedById: null,
    assignedToId: null,
    confirmationStatus: 'NEW',
    shippingStatus: 'NOT_READY',
    claimHistory: { none: {} },
    replacesOrderId: null,
  };
}

/**
 * HOLD HIS OTHER ORDERS FOR THE AGENT WHO JUST PULLED ONE. Returns the ids held.
 *
 * Called by `pullNextOrder` inside its transaction, after the claim and under the customer's lock. Each write is conditional
 * (still unclaimed, still nobody's name, still NEW, still not shipping), like `reserveReturningCustomers`', so a door that takes
 * no lock and got there first is not overwritten.
 */
export async function holdTwinsForPuller(
  tx: Tx,
  q: {
    scope: { companyId: string; storeId: string };
    customerId: string | null | undefined;
    pulled: { id: string; orderNumber?: string | null };
    agentId: string;
    /** How many more she may be named for — `CLAIM_CAPS.total` minus what is in her hands and held for her after this pull. */
    room: number;
    now: Date;
  }
): Promise<string[]> {
  // No customer, no twins — and never an empty filter that would read the whole store.
  if (!q.customerId || q.room <= 0) return [];

  const twins = await tx.order.findMany({
    where: twinsToHoldWhere(q.scope, q.customerId, q.pulled.id),
    orderBy: { createdAt: 'asc' },
    take: Math.min(q.room, MAX_TWINS_HELD),
    select: { id: true },
  });

  const held: string[] = [];
  for (const twin of twins) {
    const won = await tx.order.updateMany({
      where: { id: twin.id, claimedById: null, assignedToId: null, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY' },
      data: { assignedToId: q.agentId, assignedAt: q.now, version: { increment: 1 } },
    });
    if (won.count !== 1) continue;
    held.push(twin.id);
    await tx.orderActivity.create({
      data: {
        companyId: q.scope.companyId,
        orderId: twin.id,
        userId: null,
        action: TWIN_HELD_ACTION,
        metadata: JSON.stringify({ agentId: q.agentId, pulledOrderId: q.pulled.id, withOrder: q.pulled.orderNumber ?? null }),
      },
    });
  }
  return held;
}
