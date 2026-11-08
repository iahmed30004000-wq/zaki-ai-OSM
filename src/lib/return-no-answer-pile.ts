import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { CONTACT_RESULTS, NO_ANSWER_RESULTS } from './confirmation-workflow';
import { OPEN_CONFIRMATION, type QueueScope } from './confirmation-queue';
import { isReaching } from './no-answer-rounds';
import { MANAGER_RETURNED_REASON, managerReturnMetadata, managerReturnNotice } from './auto-release';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «أرجِع «لا يرد» للطابور» — A SUPERVISOR RETURNS A HOARDED PILE NOW (the owner, 8/11: «واذا ساحبيتو رجعهم»).
 *
 * One agent held 489 orders, 479 of them in «لا يرد», each rung once. The other agents had nothing to pull, and the only ways
 * out were a press per order (`DELETE /api/orders/[id]/claim`, 479 times) or the rounds release after six working hours. On the
 * watched desk (`desk-watch.ts`) a holder of `orders.unlock` returns up to `RETURN_PILE_LIMIT` of HER «لا يرد» orders per press,
 * is told how many remain, and presses again for the rest.
 *
 * ── WHICH ORDERS (`returnablePileWhere`) — the same «still ours» guards as the rounds release, WITHOUT its clocks ──
 *
 *   · held by her, still at the confirmation desk (`OPEN_CONFIRMATION`), never shipped (NOT_READY, no batch, no tracking
 *     number, no printed label);
 *   · somebody rang and NOBODY WAS REACHED: at least one real no-answer (`NO_ANSWER_RESULTS`), and no attempt of any other
 *     kind — an answer, a callback asked for, a decision, a wrong number or an «other» keeps the order with her;
 *   · NO DATE AHEAD: `postponedUntil` and `nextFollowUpAt` are each empty or already passed. A promise made to a customer is
 *     never taken from the person who made it.
 *
 * ⚠️ «NOBODY WAS REACHED» IS NOT «EVERY ATTEMPT IS A NO-ANSWER» — read this before changing `NOBODY_REACHED_RESULTS`.
 * The call button writes `OPENED` into the order's contact log before every call (`contact-line.ts`: «اتصال» writes OPENED), and a
 * WhatsApp sent after a no-answer writes `MESSAGE_SENT`. Neither claims an outcome (`confirmation-workflow.ts`: «recorded as
 * NOTHING MORE»; `isReaching`, `no-answer-rounds.ts`: neither is somebody reached), and with «نظام الجولات» on a round only counts
 * after an `OPENED` of the same agent (R5). So the desk of the owner's complaint — «جولة 1 من 3», each order rung once — has an
 * OPENED beside every NO_ANSWER. A rule «every attempt is in NO_ANSWER_RESULTS» would have left that pile where it was, and every
 * unit test written from the rule would have passed on fixtures that carry no OPENED. So the set is the repo's own: whatever
 * `isReaching` says did not reach anybody. A result nobody listed (a future one, a legacy one) counts as reaching and keeps the
 * order with her.
 *
 * ── WHAT IS WRITTEN — one transaction per press, the ninety-minute release's own write ──
 *
 *   · at most `RETURN_PILE_LIMIT` orders, oldest hold first, each by a CONDITIONAL update that asks again everything the read
 *     asked (hers, the same claim, still open, not shipping, no date ahead, nobody reached): an order she acted on between the
 *     read and the write is skipped and counted, never overwritten. (The rounds release re-asks five of these; the date and the
 *     contact log are asked again here because a postpone or a customer's callback logged in that gap is exactly a promise this
 *     door must not break.)
 *   · the data is `{ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null }` and
 *     nothing else: the status, the dates, the money and the lines stay as they were;
 *   · a `RELEASED` claim-history line per order that went (`MANAGER_RETURNED`, in `auto-release.ts` with its metadata and the
 *     way it is read), and the customer's other orders held FOR her are let go too — one customer, one agent
 *     (`releaseByRounds`' own step, once for the whole press);
 *   · ONE notification to her for the press (`managerReturnNotice`), written in this transaction: a return that rolls back tells
 *     nobody. The audit row is the caller's (`logAudit` never throws and does not take a transaction).
 *
 * Nothing is written when nothing qualifies: no update, no line, no notice.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The key the claim door's «سحبه منه» asks (`orders.unlock`): whoever may take any order back may return a pile. */
export const RETURN_PILE_KEY = 'orders.unlock';

/** Orders one press returns. A second press returns the rest. */
export const RETURN_PILE_LIMIT = 200;

/** 200 orders are about 200 statements: more than the default 5 seconds a transaction is given, far less than a minute. */
export const RETURN_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const;

export const RETURN_PILE_REFUSAL = 'إرجاع طلبات موظفة للطابور لمن يملك «تجاوز أقفال التحرير».';
export const OWN_DESK_REFUSAL = 'هالإرجاع لشاشة موظفة تانية، مش لشاشتك.';

/**
 * The results that left nobody reached: a no-answer, and the presses that claim no outcome. Derived from `isReaching` over the
 * known results, so there is one definition of «reached» in the code, and a result added to the list is «reached» until
 * somebody decides otherwise.
 */
export const NOBODY_REACHED_RESULTS: readonly string[] = CONTACT_RESULTS.filter((result) => !isReaching(result));

/**
 * HER «لا يرد» PILE, as a database filter — the read, the count on the desk and the write's own guard all use this one.
 * `now` is the press's clock: a date that has passed at the read has passed at the write, and a date set ahead in between
 * (she postponed it) fails the write and the order stays with her.
 */
export function returnablePileWhere(scope: QueueScope, agentId: string, now: Date) {
  return {
    ...scope,
    claimedById: agentId,
    confirmationStatus: { in: OPEN_CONFIRMATION },
    shippingStatus: 'NOT_READY',
    shippingBatchId: null,
    trackingNumber: null,
    labelPrintedAt: null,
    contactAttempts: {
      some: { result: { in: [...NO_ANSWER_RESULTS] } },
      none: { result: { notIn: [...NOBODY_REACHED_RESULTS] } },
    },
    AND: [
      { OR: [{ postponedUntil: null }, { postponedUntil: { lte: now } }] },
      { OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: now } }] },
    ],
  };
}

/** What a press will do, from how many qualify now — the desk sends this beside her orders and the dialog reads it. */
export function pressPlan(eligible: number, limit: number = RETURN_PILE_LIMIT) {
  const total = Math.max(0, Math.floor(eligible));
  return { eligible: total, limit, thisPress: Math.min(total, limit), remainingAfter: Math.max(0, total - limit) };
}

/** How many of her orders qualify right now. */
export function countReturnable(tx: Tx, scope: QueueScope, agentId: string, now: Date = new Date()): Promise<number> {
  return tx.order.count({ where: returnablePileWhere(scope, agentId, now) });
}

export interface PileReturn {
  /** Orders that went back to the queue in this press. */
  returned: number;
  /** Read as returnable, then changed before the write — left with her, and counted. */
  skipped: number;
  /** Still returnable after this press: what a second press would take. */
  remaining: number;
  limit: number;
}

/** The customer's other orders held FOR her go back with her order — one customer, one agent (`releaseByRounds`' step, once for all). */
async function releaseTwinsHeldFor(
  tx: Tx,
  scope: QueueScope,
  agentId: string,
  gone: { id: string; customerId: string | null }[]
): Promise<void> {
  const customers = [...new Set(gone.map((o) => o.customerId).filter((c): c is string => !!c))];
  if (customers.length === 0) return;
  await tx.order.updateMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      customerId: { in: customers },
      id: { notIn: gone.map((o) => o.id) },
      claimedById: null,
      confirmationStatus: 'NEW',
      shippingStatus: 'NOT_READY',
      claimHistory: { none: {} },
      assignedToId: agentId,
    },
    data: { assignedToId: null, assignedAt: null, version: { increment: 1 } },
  });
}

/**
 * ONE PRESS, inside the caller's transaction (`RETURN_TRANSACTION_OPTIONS`): read up to `limit` of her returnable orders, let
 * each one go by a conditional write, and write the lines, the twins and the one notice for those that went.
 */
export async function returnNoAnswerPile(
  tx: Tx,
  args: { scope: QueueScope; agentId: string; by: { id: string; name: string }; now?: Date; limit?: number }
): Promise<PileReturn> {
  const { scope, agentId, by } = args;
  const now = args.now ?? new Date();
  const limit = args.limit ?? RETURN_PILE_LIMIT;

  const rows = await tx.order.findMany({
    where: returnablePileWhere(scope, agentId, now),
    orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, claimedAt: true, customerId: true },
  });

  const gone: { id: string; customerId: string | null }[] = [];
  let skipped = 0;
  for (const row of rows) {
    const done = await tx.order.updateMany({
      // Still hers, still the same claim, still returnable: whatever she did since the read wins.
      where: { ...returnablePileWhere(scope, agentId, now), id: row.id, claimedAt: row.claimedAt },
      // Exactly what the ninety-minute release writes.
      data: { claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null },
    });
    if (done.count !== 1) {
      skipped++;
      continue;
    }
    gone.push({ id: row.id, customerId: row.customerId });
  }

  if (gone.length > 0) {
    await tx.orderClaimHistory.createMany({
      data: gone.map((o) => ({
        companyId: scope.companyId,
        orderId: o.id,
        // Still whose order it was; `metadata` says who pressed (auto-release.ts).
        userId: agentId,
        action: 'RELEASED',
        reason: MANAGER_RETURNED_REASON,
        metadata: managerReturnMetadata(agentId, by),
      })),
    });
    await releaseTwinsHeldFor(tx, scope, agentId, gone);
    await tx.notification.create({
      data: managerReturnNotice({ companyId: scope.companyId, storeId: scope.storeId, holderId: agentId, by, returned: gone.length }),
    });
  }

  const remaining = await tx.order.count({ where: returnablePileWhere(scope, agentId, now) });
  return { returned: gone.length, skipped, remaining, limit };
}

/** The one line the press answers with, for the toast: what went, what is left, what could not move. */
export function pileMessage(r: PileReturn): string {
  if (r.returned === 0) {
    return r.skipped > 0
      ? `تغيّرت الطلبات وقت الإرجاع (${r.skipped}) — حدّث الشاشة وجرّب تاني`
      : 'ما في طلب «لا يرد» يرجع هلأ — اللي عليه موعد أو اللي ردّ زبونه بيضل عندها';
  }
  const parts = [`رجع ${r.returned} طلب «لا يرد» للطابور`];
  if (r.skipped > 0) parts.push(`و${r.skipped} تغيّروا وبقوا عندها`);
  if (r.remaining > 0) parts.push(`باقي ${r.remaining} — اضغط تاني`);
  return parts.join(' — ');
}
