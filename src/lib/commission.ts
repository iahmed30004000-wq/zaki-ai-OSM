import { earnedBy, parseTiers, type CommissionType } from './commission-rules';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { roundMinor } from './money';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * COMMISSION — one source of truth.
 *
 * Rules are DATA with an effective_from date, so changing a rule today never
 * recalculates a closed period. Commission is ACCRUED when the order is
 * delivered and becomes PAYABLE only after the settlement that covers it is
 * approved. A returned order generates zero commission for every party, and
 * a correction is a reversing entry — an approved month is never rewritten.
 *
 * The legacy per-user `User.commissionRate` is NOT used here: two sources
 * would diverge the first time someone edited one of them.
 */

export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface RuleLike {
  id: string;
  appliesToRole: string | null;
  appliesToUserId: string | null;
  type: string;
  value: number | Prisma.Decimal;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
  /** What it counts. Absent on a rule written before metrics existed. */
  metric?: string | null;
  /** Over what span. PER_ORDER accrues here; the rest are the scheduler's. */
  period?: string | null;
  tiers?: unknown;
  minOrders?: number | null;
  productId?: string | null;
}

/** A rule that pays as each order is delivered — what this file accrues. */
export function isPerOrderRule(rule: { metric?: string | null; period?: string | null }): boolean {
  return (rule.period ?? 'PER_ORDER') === 'PER_ORDER' && (rule.metric ?? 'ORDER_DELIVERED') === 'ORDER_DELIVERED';
}

/**
 * The rule that governs an order: the most specific one (a rule for this
 * person beats a rule for their role) that was in force ON THE DAY the
 * order was delivered — not today.
 */
export function ruleFor(
  rules: RuleLike[],
  params: { userId: string; role: string; at: Date }
): RuleLike | null {
  const candidates = rules.filter(
    (r) =>
      r.isActive &&
      r.effectiveFrom <= params.at &&
      (!r.effectiveTo || r.effectiveTo >= params.at) &&
      (r.appliesToUserId === params.userId || (!r.appliesToUserId && r.appliesToRole === params.role))
  );
  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    const specific = Number(!!b.appliesToUserId) - Number(!!a.appliesToUserId);
    if (specific !== 0) return specific;
    return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  })[0];
}

/**
 * What one delivered order earns under a per-order rule.
 *
 * A per-order rule has no count to band on — the count is one — so its tiers
 * are read against the SALE VALUE instead: "an order over 200 pays more".
 * A rule with no tiers keeps its single value, exactly as before.
 */
export function commissionAmount(rule: RuleLike, orderRevenue: number, minorUnit: number): number {
  const tiers = parseTiers(rule.tiers);
  const earned = earnedBy({
    type: (rule.type as CommissionType) ?? 'FIXED',
    value: Number(rule.value),
    tiers,
    count: tiers ? orderRevenue : 1,
    sample: 1,
    amount: orderRevenue,
    minorUnit,
  });
  return earned.amount;
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHO GETS A LINE ON A DELIVERED ORDER — the one place it is decided.
 *
 * Two parties can earn on one order: its responsible moderator (`moderatorId` — for a person who does not hand orders out,
 * whoever typed it: D10, `responsible-moderator.ts`) and whoever gave the yes (`confirmedById`). One person in both seats is
 * one line (T-06, `who-types-and-confirms-is-paid-once.test.ts`).
 *
 * THE OWNER'S RULING, 3/11, on RV693: «التأكيد» — the commission goes to the one who CONFIRMS. An order a confirmation agent
 * typed and a colleague confirmed (the «أكّده الآن» box unticked, or her cap full) paid the agent rate twice: a 45 JOD order,
 * 2.100 + 2.100 = 4.200. So when the moderator seat holds a CONFIRMATION_AGENT and a DIFFERENT person confirmed, her line is
 * not written — only the confirmer's: 2.100.
 *
 * WHAT IT DOES NOT CHANGE:
 *   · an order a MODERATOR typed: the moderator's line stays (1.000 + 2.100 = 3.100) — bringing the order is her work;
 *   · an order the agent typed and confirmed herself: one line, as before;
 *   · an order nobody confirmed (no `confirmedById`): the moderator seat keeps its line, whoever sits in it;
 *   · any rate, rounding or amount — this decides WHICH people, never HOW MUCH;
 *   · an entry already written: nothing is rewritten or backfilled; the accrual's own guard still finds it.
 *
 * By the person's role at accrual time — the same `User.role` the rules themselves are matched on (`ruleFor`), so the
 * question «is this an agent's line» is asked in the words the rule that would pay it was written in.
 * ═══════════════════════════════════════════════════════════════════════
 */
export const PAID_BY_CONFIRMING_ROLES: readonly string[] = ['CONFIRMATION_AGENT'];

type PartySeat = { id: string; role: string; commissionCurrency?: string | null } | null | undefined;

export interface CommissionParty {
  userId: string;
  role: string;
  currency: string | null;
}

export function partiesOf(order: { moderator?: PartySeat; confirmer?: PartySeat }): CommissionParty[] {
  const moderator = order.moderator ?? null;
  const confirmer = order.confirmer ?? null;
  const confirmedByAnother = !!confirmer && confirmer.id !== moderator?.id;
  // RV693: an agent's line in the moderator seat is earned by confirming — and somebody else confirmed.
  const typistLosesTheLine = !!moderator && confirmedByAnother && PAID_BY_CONFIRMING_ROLES.includes(moderator.role);

  const parties: CommissionParty[] = [];
  if (moderator && !typistLosesTheLine) {
    parties.push({ userId: moderator.id, role: moderator.role, currency: moderator.commissionCurrency ?? null });
  }
  if (confirmer && confirmedByAnother) {
    parties.push({ userId: confirmer.id, role: confirmer.role, currency: confirmer.commissionCurrency ?? null });
  }
  return parties;
}

export interface AccrualResult {
  created: number;
  skipped: 'NOT_DELIVERED' | 'RETURNED' | 'NO_RULE' | 'ALREADY_ACCRUED' | null;
  amount?: number;
}

/**
 * Accrue commission for one delivered order. Idempotent: a second call for
 * the same order and person does nothing, so a retried job cannot double-pay.
 */
export async function accrueForOrder(
  tx: Tx,
  params: { companyId: string; orderId: string; minorUnit: number }
): Promise<AccrualResult> {
  const order = await tx.order.findFirst({
    where: { id: params.orderId, companyId: params.companyId },
    select: {
      id: true, storeId: true, shippingStatus: true, deliveredAt: true, currency: true,
      totalAmount: true, deliveryFee: true, priceIncludesDelivery: true,
      moderatorId: true, claimedById: true, confirmedById: true,
      // commissionCurrency: what this person's commission is counted in.
      // An Egyptian moderator earns in pounds even in a Syrian store's
      // order — and is paid from whatever wallet has the money, at a rate
      // the owner writes when they pay it (commission-payout.ts).
      moderator: { select: { id: true, role: true, commissionCurrency: true } },
      confirmer: { select: { id: true, role: true, commissionCurrency: true } },
    },
  });
  if (!order) throw new Error('Order not found');

  // A returned order earns nobody anything.
  if (['RETURNED', 'RETURN_REQUESTED', 'FAILED_DELIVERY'].includes(order.shippingStatus)) {
    return { created: 0, skipped: 'RETURNED' };
  }
  // DELIVERED, AND ONLY DELIVERED — A PARTIAL DELIVERY EARNS NOTHING.
  //
  // This is a decision, not an oversight, and it does not follow from the
  // line below: `!== 'DELIVERED'` happens to exclude PARTIALLY_DELIVERED,
  // and somebody widening it to `['DELIVERED', 'PARTIALLY_DELIVERED']` for
  // consistency with the stock, settlement and returns paths — which were
  // all deliberately widened — would start paying commission on partials
  // without anybody deciding to.
  //
  // The profit line does count a partial's revenue, so the two are
  // asymmetric on purpose: the money came in, and nobody earns on it.
  if (order.shippingStatus !== 'DELIVERED') return { created: 0, skipped: 'NOT_DELIVERED' };

  const at = order.deliveredAt ?? new Date();
  const period = periodOf(at);

  /**
   * This STORE's agreement, never the company's.
   *
   * The rules used to be company-wide, so one store's arrangement with its
   * agents paid out on another store's deliveries — money leaving the wrong
   * books, and nobody notices until the month closes. A rule with no store
   * has not been placed yet and pays nothing: allowing it everywhere is the
   * same leak in a different shape.
   */
  // ONLY the rules that pay per order. A rule counting a day's confirmed
  // orders cannot be answered from one order — the day has not closed —
  // and it is accrued by the scheduler instead (commission-period.ts).
  const rules = ((await tx.commissionRule.findMany({
    where: { companyId: params.companyId, storeId: order.storeId, isActive: true },
  })) as unknown as RuleLike[]).filter(isPerOrderRule);

  // Commission is earned on the sale, not on the courier's fee. `totalAmount`
  // holds the COD figure from computeCod, and COD minus the fee is the sale
  // revenue under BOTH pricing modes: with the fee included COD is the net and
  // revenue is net − fee; with it added on top COD is net + fee, so
  // COD − fee is the net again. One expression covers both on purpose.
  const revenue = Number(order.totalAmount) - Number(order.deliveryFee ?? 0);

  const parties = partiesOf(order);

  let created = 0;
  let total = 0;
  for (const party of parties) {
    const rule = ruleFor(rules, { userId: party.userId, role: party.role, at });
    if (!rule) continue;

    const existing = await tx.commissionEntry.findFirst({
      where: { orderId: order.id, userId: party.userId, status: { in: ['ACCRUED', 'PAYABLE', 'PAID'] } },
      select: { id: true },
    });
    if (existing) continue;

    const amount = commissionAmount(rule, revenue, params.minorUnit);
    if (amount <= 0) continue;

    await tx.commissionEntry.create({
      data: {
        companyId: params.companyId,
        orderId: order.id,
        userId: party.userId,
        role: party.role,
        ruleId: rule.id,
        amount,
        // Theirs where they have one; the order's where they do not, which
        // is how it always worked and stays right for everybody local.
        currencyCode: party.currency || order.currency,
        status: 'ACCRUED',
        periodMonth: period,
      },
    });
    created++;
    total += amount;
  }

  if (created === 0) return { created: 0, skipped: 'NO_RULE' };
  return { created, skipped: null, amount: roundMinor(total, params.minorUnit) };
}

/**
 * Reverse every commission of an order — used when a delivered order comes
 * back. The original entries stay; a reversing entry cancels them out.
 */
export async function reverseForOrder(
  tx: Tx,
  params: { companyId: string; orderId: string; reason: string }
) {
  const entries = await tx.commissionEntry.findMany({
    where: { companyId: params.companyId, orderId: params.orderId, status: { in: ['ACCRUED', 'PAYABLE', 'PAID'] } },
  });

  let reversed = 0;
  for (const entry of entries) {
    const already = await tx.commissionEntry.findUnique({ where: { reversalOfId: entry.id } });
    if (already) continue;

    await tx.commissionEntry.create({
      data: {
        companyId: entry.companyId,
        orderId: entry.orderId,
        userId: entry.userId,
        role: entry.role,
        ruleId: entry.ruleId,
        amount: Number(entry.amount) * -1,
        currencyCode: entry.currencyCode,
        status: 'REVERSED',
        // The reversal lands in the CURRENT period: an approved month is closed.
        periodMonth: periodOf(new Date()),
        reversalOfId: entry.id,
        reversalReason: params.reason,
      },
    });
    reversed++;
  }
  return reversed;
}

/**
 * WHAT THE COMMISSION ON A SET OF ORDERS ACTUALLY COST.
 *
 * The one number the profit line may subtract. Read from the LEDGER, so it
 * is the same money the commission screen shows and the same money a payout
 * would pay — rather than a second figure computed another way, which is
 * what `Order.moderatorCommission` was.
 *
 * EVERY status is summed, REVERSED included, because a reversal is a
 * NEGATIVE entry: the original and its reversal cancel, which is exactly
 * what a returned order should do to the month's cost. Filtering them out
 * would leave the profit line carrying commission on an order that came
 * back.
 *
 * Scoped by the ORDERS, not by the entry's period: profit is asked about a
 * window of orders, and an entry belongs to the order that generated it.
 */
export async function commissionCostForOrders(
  orderWhere: Record<string, unknown>
): Promise<number> {
  const agg = await db.commissionEntry.aggregate({
    where: { order: orderWhere },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}

/**
 * WHAT EACH PERSON EARNED ON A SET OF ORDERS.
 *
 * The leaderboard's commission column, read from the same ledger the profit
 * line and the payout read, so the three agree by construction.
 *
 * Keyed on the ENTRY's userId, not the order's `moderatorId`: an order can
 * earn commission for somebody who is not the moderator of record (a
 * confirmer, a second party on a rule), and the money belongs to whoever
 * the rule named. REVERSED entries are summed with the rest — a reversal is
 * a negative entry, so a returned order nets to nothing.
 */
export async function commissionByUserForOrders(
  orderWhere: Record<string, unknown>
): Promise<Map<string, number>> {
  const groups = await db.commissionEntry.groupBy({
    by: ['userId'],
    where: { order: orderWhere },
    _sum: { amount: true },
  });
  return new Map(groups.map((g) => [g.userId, Number(g._sum.amount ?? 0)]));
}

/**
 * Settlement approval is what makes commission payable: before the money is
 * in, nobody is owed anything.
 */
export async function markPayableForOrders(tx: Tx, companyId: string, orderIds: string[]) {
  if (orderIds.length === 0) return 0;
  const res = await tx.commissionEntry.updateMany({
    where: { companyId, orderId: { in: orderIds }, status: 'ACCRUED' },
    data: { status: 'PAYABLE' },
  });
  return res.count;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE PAYOUT DOOR PROMOTES WHAT IS ALREADY SETTLED.
 *
 * `markPayableForOrders` above is a MOMENT. It runs once, inside the
 * transaction that approves a statement, over the orders that statement
 * matched. The condition it stands for — "the money for this order is in" —
 * is a STATE: the order is settled, and it stays settled for ever.
 *
 * A MOMENT CANNOT CATCH WHAT ARRIVES AFTER IT. And on the normal path the
 * entry arrives after it:
 *
 *   statement approval — ONE transaction, in this order:
 *     markPayableForOrders(matched orders)   ← no entry exists yet: 0 promoted
 *     the orders become DELIVERED and SETTLED
 *     (delivery is what the statement proves; the accrual is not here)
 *   the nightly accrual job, hours later, or somebody pressing the button:
 *     accrueForOrder creates the entry — status ACCRUED
 *
 * The entry is now ACCRUED for ever. Its order is SETTLED, the cash is in
 * the wallet, and the only writer of PAYABLE already ran. The payout door
 * then refuses it with NOT_PAYABLE and tells the owner it «becomes payable
 * when the collection statement is approved» — an approval already months
 * past. Two orders on the golden-path walk ended exactly there, and it is
 * not an edge case: it is every order the statement delivers, which is
 * every order nobody ticked by hand.
 *
 * Re-ordering the statement transaction would not fix it either. The accrual
 * does not happen in that transaction at all, and making it happen there
 * would put the most delicate transaction in the system in charge of
 * commission rules, tiers and currencies. The moment is in the wrong place
 * for a reason that cannot be moved.
 *
 * So the door asks the STATE instead of trusting that the moment caught it.
 * This is the where-clause it asks with — a filter and not a boolean, on
 * purpose: a read, a decision in JavaScript, and then a write would let two
 * payouts both see ACCRUED and both pay. One conditional UPDATE cannot.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const PROMOTABLE_BY_PAYOUT: Prisma.CommissionEntryWhereInput = {
  // ACCRUED and nothing else. Not PAYABLE — that one needs no promoting.
  // Not PAID — the money already left. Not REVERSED — that row IS the
  // negative correction, and promoting it would make the business "owe" a
  // negative amount it would then try to pay out.
  status: 'ACCRUED',
  // Never one already attached to a payment. Status and payout are two
  // facts, and an entry whose status was dragged backwards by hand while a
  // payoutId still hung off it would otherwise be paid a second time.
  payoutId: null,
  /**
   * NEVER AN ENTRY THAT HAS BEEN REVERSED.
   *
   * A reversal does not touch the entry it cancels. `reverseForOrder` writes
   * a SECOND, negative entry pointing back at the first through
   * `reversalOfId` — so the original of a returned order is still sitting at
   * ACCRUED, untouched, looking exactly like an entry waiting to be paid.
   *
   * And its order can perfectly well be SETTLED: delivered, settled, the
   * money collected, and only then returned. Nothing un-settles an order
   * that came back. Promote that entry and the business pays commission on
   * goods sitting back on its own shelf. The negative entry nets it out of
   * the profit line and the leaderboard — and does not net it out of the
   * wallet, because nothing pays a negative entry.
   */
  reversedBy: { is: null },
  /**
   * THE STATE THE MOMENT STOOD FOR, asked directly.
   *
   * SETTLED only. Not PARTIALLY_SETTLED and not COLLECTED: the invariant is
   * that no commission is payable before the settlement that covers it is
   * approved, and a partial settlement is money still outstanding.
   *
   * A null `orderId` — a PERIOD entry, earned over a span rather than on one
   * order ("150 confirmed in a day") — has no order to be settled, and this
   * filter excludes it because Prisma reads a relation filter on a nullable
   * relation as "the related row exists AND matches". That is the right
   * answer and not an accident: no statement covers a period entry, so
   * there is no settlement for the door to find. See the report below.
   */
  order: { settlementStatus: 'SETTLED' },
};

/**
 * Promote the entries a payout is about to pay, if their money is already in.
 *
 * Scoped to the exact entries being paid, to this company and to this one
 * person: a payout for Sara must not quietly make Omar's commission payable
 * as a side effect, because the figure he was shown a second earlier would
 * then be a different figure from the one in the database.
 *
 * Idempotent by construction. `status: 'ACCRUED'` is in the WHERE, so a
 * second call promotes nothing — and under Postgres' row locks a concurrent
 * payout blocks here, re-reads the committed row, finds PAYABLE instead of
 * ACCRUED, and promotes nothing either. The promotion can never run twice on
 * one entry, so it can never be the thing that lets one entry be paid twice.
 */
export async function promoteSettledToPayable(
  tx: Tx,
  params: { companyId: string; userId: string; entryIds: string[] }
): Promise<number> {
  if (params.entryIds.length === 0) return 0;
  const res = await tx.commissionEntry.updateMany({
    where: {
      ...PROMOTABLE_BY_PAYOUT,
      id: { in: params.entryIds },
      companyId: params.companyId,
      userId: params.userId,
    },
    data: { status: 'PAYABLE' },
  });
  return res.count;
}
