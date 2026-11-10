import { db } from '../db';
import { processStoredMessage } from './inbound';
import { heldUntil, holdUntil } from './upsell-pair';

/**
 * THE TEN MINUTES ARE OVER — A HALF OF AN UPSELL PAIR STOPS WAITING.
 *
 * A message that is half of a pair waits for the other half as a review with a reason (`WAITING_FOR_UPSELL:<until>` or
 * `WAITING_FOR_BASE:<until>`, `inbound.ts`): no new status and no job. Nothing wakes it up on time; it is released LAZILY,
 * when somebody looks — at the start of the list (`GET /api/telegram/messages`) and of «إعادة المعالجة». Released means read
 * again with the wait off, so it gets the reason it would have had without the pair: PRICE_MISMATCH for a base, and
 * UPSELL_WITHOUT_BASE for an upsell — or, if its partner came in the meantime, the order.
 *
 * Never throws: a failure here must not cost anybody the list.
 */
export async function releaseExpiredHolds(companyId: string, now: Date = new Date()): Promise<number> {
  try {
    const held = await db.telegramMessage.findMany({
      where: { companyId, processingStatus: 'NEEDS_REVIEW', orderId: null, reviewReason: { startsWith: 'WAITING_FOR_' } },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, reviewReason: true, createdAt: true },
    });
    let released = 0;
    for (const message of held ?? []) {
      const until = heldUntil(message.reviewReason) ?? holdUntil(message.createdAt);
      if (until.getTime() > now.getTime()) continue;
      await processStoredMessage(message.id, { holds: false, now }).catch(() => undefined);
      released++;
    }
    return released;
  } catch {
    return 0;
  }
}
