import { db } from './db';
import { resolveAudience } from './notification-audience';
import { agentForReturningCustomer, reservationCutoff, type PriorOrder } from './order-reservation';

/**
 * HOLD A RETURNING CUSTOMER'S NEW ORDER FOR THE AGENT WHO WORKED HIM LAST.
 *
 * The rule and the words are `order-reservation.ts`; this is the one writer. It runs where an order is about to be taken —
 * «اسحب التالي», the queue read, taking one by id — and once a minute from the scheduler, so an order is held within the
 * minute it arrives and the agent finds it in her «الطلبات» without anybody having pulled.
 *
 * ── WHY NOT IN THE CREATION DOORS ──
 *
 * Seven doors write an order (the shop, Telegram, the API, the quick entry, the AI intake, the import, a replacement) and each
 * writes `assignedToId: null` on its own. Putting the rule in each would be seven copies of it and a change to how an order is
 * created; one step AFTER the order exists is one copy and touches no creation.
 *
 * ── WHAT IT DOES ──
 *
 *   1. The orders that have just arrived and nobody holds or has been named for (NEW, unclaimed, unassigned, under 24h old).
 *   2. Each one's customer's earlier orders (this store only — a customer is a store's), newest first.
 *   3. The agent who worked the newest of them — and only if she is ACTIVE, may pull and can enter the store.
 *   4. One conditional write per order: it names her only if the order is STILL unclaimed and unassigned.
 *
 * Best-effort by design: the callers wrap it, because a hold that could not be written must never stop an agent from pulling
 * (the order is then simply the shared queue's, as it was before this existed).
 */
export async function reserveReturningCustomers(
  scope: { companyId: string; storeId: string },
  now: Date = new Date(),
  opts: { orderIds?: readonly string[] } = {}
): Promise<number> {
  const candidates = await db.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      claimedById: null,
      assignedToId: null,
      confirmationStatus: 'NEW',
      shippingStatus: 'NOT_READY',
      // Older than a day, it would already have let go.
      createdAt: { gt: reservationCutoff(now) },
      // Never claimed: an order somebody once held and gave back (or the owner pulled back on purpose) is not an arrival, and is
      // not held for anyone a second time.
      claimHistory: { none: {} },
      ...(opts.orderIds ? { id: { in: [...opts.orderIds] } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: { id: true, customerId: true },
  });
  if (candidates.length === 0) return 0;

  const customerIds = [...new Set(candidates.map((c) => c.customerId))];
  const priorRows = await db.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      customerId: { in: customerIds },
      id: { notIn: candidates.map((c) => c.id) },
      OR: [{ claimedById: { not: null } }, { currentOwnerId: { not: null } }, { confirmedById: { not: null } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 2000,
    select: { customerId: true, claimedById: true, currentOwnerId: true, confirmedById: true },
  });

  const priors = new Map<string, PriorOrder[]>();
  for (const row of priorRows) priors.set(row.customerId, [...(priors.get(row.customerId) ?? []), row]);
  if (priors.size === 0) return 0;

  // Resolved only now that somebody has a history: the audience is several queries, and most arrivals are first-timers.
  const eligible = new Set(
    (
      await resolveAudience({
        companyId: scope.companyId,
        storeId: scope.storeId,
        audience: { permission: 'confirmation.pull' },
      })
    ).map((u) => u.id)
  );

  let held = 0;
  for (const candidate of candidates) {
    const agent = agentForReturningCustomer(priors.get(candidate.customerId) ?? [], eligible);
    if (!agent) continue;

    const won = await db.order.updateMany({
      where: { id: candidate.id, claimedById: null, assignedToId: null, confirmationStatus: 'NEW' },
      data: { assignedToId: agent, assignedAt: now, version: { increment: 1 } },
    });
    if (won.count !== 1) continue;
    held += 1;

    await db.orderActivity.create({
      data: {
        companyId: scope.companyId,
        orderId: candidate.id,
        userId: null,
        action: 'HELD_FOR_AGENT',
        metadata: JSON.stringify({ agentId: agent, reason: 'RETURNING_CUSTOMER' }),
      },
    });
  }
  return held;
}
