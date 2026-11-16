import type { Prisma } from '@prisma/client';
import { measure } from './commission-metrics';
import { DELIVERED_SHIPPING, RETURNED_SHIPPING } from './order-state';
import { DELIVERY_MATURITY_DAYS } from './agent-scorecard';
import type { AgentCommissionConfig } from './agent-commission-settings';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COMMISSION CALCULATOR (Confirmation Center v2, step G2) — an ESTIMATE of one agent's month, with the rule that made every number. Pure arithmetic + a read.
 *
 * It is NOT the ledger: it writes nothing, pays nothing, and never feeds an accrual, a payout or a profit figure (`commission.ts`, `commission-period.ts`,
 * `commission-payout.ts` keep their own arithmetic untouched, and `every-money-writer-is-known` / `money-goes-through-one-door` pin that nothing here writes money).
 * The confirmed count IS the commission base's (`measure(…, 'CONFIRMED_COUNT')` of `commission-metrics.ts`: confirmed by her, in the month, a cancelled order out) — one source of «confirmed».
 *
 * THE STEPS (each is a sentence in `steps`, so the screen can show «قاعدة الاحتساب» for the figure):
 *   1. the bonus: from `minOrders` confirmed orders in the month, `perOrder` × the count REPLACES the tier's lump sum (and the gate does not apply to it);
 *   2. otherwise the tier: the highest tier whose `from` is at most the count (below the first: nothing);
 *   3. the quality gate, if the owner turned it on: a delivery rate (delivered ÷ (delivered + returned) of her confirmations at least `DELIVERY_MATURITY_DAYS` old)
 *      below `minDeliveryRate` moves her ONE tier down; with no mature delivery to judge by the gate is NOT applied, and the estimate says so.
 * ═══════════════════════════════════════════════════════════════════════
 */

export interface Estimate {
  /** The month's estimate in the currency's whole units. */
  amount: number;
  /** The confirmed count it rests on. */
  confirmed: number;
  /** 1-based tier she is paid at (after the gate); 0 = below the first tier or the bonus applies. */
  tier: number;
  kind: 'BONUS' | 'TIER' | 'NONE';
  gate: { enabled: boolean; applied: boolean; deliveryRate: number | null; minDeliveryRate: number };
  /** «قاعدة الاحتساب»: one Arabic sentence per step taken. */
  steps: string[];
}

const money = (n: number) => n.toLocaleString('en-US');

export function estimateCommission(config: AgentCommissionConfig, input: { confirmed: number; deliveryRate: number | null }): Estimate {
  const { confirmed, deliveryRate } = input;
  const steps: string[] = [`المؤكَّد بالشهر: ${confirmed} طلب (نفس أساس العمولة).`];
  const gate = { enabled: config.qualityGate.enabled, applied: false, deliveryRate, minDeliveryRate: config.qualityGate.minDeliveryRate };

  if (confirmed >= config.bonus.minOrders) {
    const amount = confirmed * config.bonus.perOrder;
    steps.push(`وصلت ${config.bonus.minOrders} طلب أو أكتر: ${config.bonus.perOrder} لكل طلب بدل مبلغ الشريحة = ${confirmed} × ${config.bonus.perOrder} = ${money(amount)}.`);
    if (gate.enabled) steps.push('بوابة الجودة ما بتنطبق على البونص.');
    return { amount, confirmed, tier: 0, kind: 'BONUS', gate, steps };
  }

  const reached = config.tiers.filter((t) => t.from <= confirmed).length;
  if (reached === 0) {
    steps.push(`أقل من أول شريحة (${config.tiers[0].from} طلب): ما في عمولة بهالتقدير.`);
    return { amount: 0, confirmed, tier: 0, kind: 'NONE', gate, steps };
  }
  steps.push(`وصلت الشريحة ${reached} (من ${config.tiers[reached - 1].from} طلب): ${money(config.tiers[reached - 1].value)}.`);

  let tier = reached;
  if (gate.enabled) {
    if (deliveryRate === null) {
      steps.push('بوابة الجودة مفعّلة بس ما في تأكيدات صار عليها ' + DELIVERY_MATURITY_DAYS + ' أيام تنحكم عليها: ما انطبقت.');
    } else if (deliveryRate < gate.minDeliveryRate) {
      tier = reached - 1;
      gate.applied = true;
      steps.push(`بوابة الجودة: نسبة التسليم ${deliveryRate}% أقل من ${gate.minDeliveryRate}%: نزلت شريحة وحدة.`);
    } else {
      steps.push(`بوابة الجودة: نسبة التسليم ${deliveryRate}% (${gate.minDeliveryRate}% أو أكتر): بقيت بشريحتها.`);
    }
  }
  if (tier === 0) {
    steps.push('نزلت تحت أول شريحة: ما في عمولة بهالتقدير.');
    return { amount: 0, confirmed, tier: 0, kind: 'NONE', gate, steps };
  }
  const amount = config.tiers[tier - 1].value;
  if (gate.applied) steps.push(`المبلغ بالشريحة ${tier}: ${money(amount)}.`);
  return { amount, confirmed, tier, kind: 'TIER', gate, steps };
}

export interface PreviewRow {
  userId: string;
  name: string;
  estimate: Estimate;
}

/** Delivered ÷ (delivered + returned) as a whole percent over confirmations at least `DELIVERY_MATURITY_DAYS` old; null when there is nothing to judge by. */
export function matureDeliveryRate(rows: readonly { shippingStatus: string; confirmedAt: Date }[], now: Date): number | null {
  const mature = now.getTime() - DELIVERY_MATURITY_DAYS * 86_400_000;
  let delivered = 0;
  let returned = 0;
  for (const r of rows) {
    if (r.confirmedAt.getTime() > mature) continue;
    if ((DELIVERED_SHIPPING as readonly string[]).includes(r.shippingStatus)) delivered += 1;
    else if ((RETURNED_SHIPPING as readonly string[]).includes(r.shippingStatus)) returned += 1;
  }
  return delivered + returned === 0 ? null : Math.round((delivered / (delivered + returned)) * 100);
}

/** The month's estimates for everyone who confirmed in the span, best-effort ordering by name only. Read only. */
export async function readCommissionPreview(
  client: Client,
  scope: { companyId: string; storeId: string; start: Date; end: Date },
  config: AgentCommissionConfig,
  now: Date = new Date()
): Promise<PreviewRow[]> {
  const confirmedBy = await client.order.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, confirmedById: { not: null }, confirmedAt: { gte: scope.start, lt: scope.end } },
    distinct: ['confirmedById'],
    select: { confirmedById: true },
    take: 500,
  });
  const userIds = confirmedBy.map((o) => o.confirmedById!);
  if (userIds.length === 0) return [];
  const [users, rows] = await Promise.all([
    client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    client.order.findMany({
      where: { companyId: scope.companyId, storeId: scope.storeId, confirmedById: { in: userIds }, confirmedAt: { gte: scope.start, lt: scope.end } },
      select: { confirmedById: true, confirmedAt: true, shippingStatus: true },
      take: 100_000,
    }),
  ]);
  const out: PreviewRow[] = [];
  for (const u of users) {
    const counted = await measure(client as never, 'CONFIRMED_COUNT', { companyId: scope.companyId, storeId: scope.storeId, userId: u.id, start: scope.start, end: scope.end });
    const mine = rows.filter((r) => r.confirmedById === u.id).map((r) => ({ shippingStatus: r.shippingStatus, confirmedAt: r.confirmedAt! }));
    out.push({ userId: u.id, name: u.name ?? '—', estimate: estimateCommission(config, { confirmed: counted.count, deliveryRate: matureDeliveryRate(mine, now) }) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}
