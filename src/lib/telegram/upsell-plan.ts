import { db } from '../db';
import { planStoredMessage, processStoredMessage, type Decision } from './inbound';
import { reviewReasonText } from './review-reasons';
import { UPSELL_RETRO_MS } from './upsell-pair';

/**
 * «دمج الأب سيل — تجربة» — WHAT THE NEW RULES WOULD DO WITH THE MESSAGES ALREADY WAITING, AND THEN, ON «نعم», DOING IT.
 *
 * The owner, 10/11: «A dry-run over the current «للمراجعة» items returns a table (رقم الطلب، المنتج، العبوات، المبلغ، الإجراء).
 * Apply only after Ahmad's «نعم».» and «Include them [the old names] in the dry-run table.»
 *
 * Every waiting message (NEEDS_REVIEW, no order) of the person's store scope is put through the door's OWN decision function in
 * its write-free mode (`planStoredMessage`): not a second copy of the rules. Listed are the ones the new rules touch — a pair
 * of the same «رقم الطلب» (within `UPSELL_RETRO_MS` of each other, after the fact), a message whose product is an old name,
 * and an upsell message — each with what it would become: «يندمج في طلب واحد», «يصير طلب», or «يبقى بالمراجعة — <السبب>».
 *
 * Apply plans again on the server (the preview the screen holds is never trusted) and runs the live door on each row that
 * would become an order, with the same window. A row that already became an order is not waiting any more, so it is not
 * planned again: pressing twice makes nothing twice.
 */

/** The most waiting messages one plan reads. */
const PLAN_LIMIT = 500;

export const ACTION_MERGE = 'يندمج في طلب واحد';
export const ACTION_ORDER = 'يصير طلب';
export const ACTION_STAYS = 'يبقى بالمراجعة';

export interface PlanRow {
  /** `pair:<base>:<upsell>` or `msg:<id>` — what «نعم» names. */
  key: string;
  kind: 'merge' | 'order' | 'review';
  orderNumber: string | null;
  /** The CATALOGUE product (the lines', joined), never the old text. */
  product: string;
  /** Every unit of the order it would make: paid + gift + upsell. Null for a row that stays. */
  units: number | null;
  /** The order's total for a row that becomes one; the written «السعر» for one that stays. */
  amount: number | null;
  action: string;
  reason?: string;
  baseId: string;
  upsellId: string | null;
}

function rowOf(id: string, decision: Decision): PlanRow | null {
  const { info } = decision;
  if (!info.via) return null;
  const partner = info.partnerId;
  const baseId = info.role === 'upsell' && partner ? partner : id;
  const upsellId = info.role === 'upsell' ? id : info.role === 'base' && partner ? partner : null;
  const key = upsellId && baseId !== upsellId ? `pair:${baseId}:${upsellId}` : `msg:${id}`;
  if (decision.kind === 'order') {
    const { draft } = decision;
    const names = [...new Set([draft.line, ...draft.extraLines].map((l) => l.product.name))];
    const merged = draft.linkIds.length > 1;
    return {
      key,
      kind: merged ? 'merge' : 'order',
      orderNumber: info.orderNumber,
      product: names.join(' + '),
      units: draft.units,
      amount: draft.total,
      action: merged ? ACTION_MERGE : ACTION_ORDER,
      baseId: draft.base.id,
      upsellId: merged ? draft.linkIds[1] : null,
    };
  }
  return {
    key,
    kind: 'review',
    orderNumber: info.orderNumber,
    product: info.productName ?? '—',
    units: null,
    amount: info.written,
    action: `${ACTION_STAYS} — ${reviewReasonText(decision.reason) || decision.reason}`,
    reason: decision.reason,
    baseId,
    upsellId,
  };
}

/** The plan: one row per pair or message the new rules touch, in arrival order. Writes nothing. */
export async function planWaitingMessages(companyId: string, scope: object): Promise<PlanRow[]> {
  const waiting = await db.telegramMessage.findMany({
    where: { companyId, processingStatus: 'NEEDS_REVIEW', orderId: null, AND: [scope] },
    orderBy: { createdAt: 'asc' },
    take: PLAN_LIMIT,
    select: { id: true },
  });
  const rows: PlanRow[] = [];
  const covered = new Set<string>();
  for (const { id } of waiting) {
    if (covered.has(id)) continue;
    const decision = await planStoredMessage(id, { pairWindowMs: UPSELL_RETRO_MS });
    if (!decision) continue;
    const row = rowOf(id, decision);
    if (!row) continue;
    covered.add(row.baseId);
    if (row.upsellId) covered.add(row.upsellId);
    if (rows.some((r) => r.key === row.key)) continue;
    rows.push(row);
  }
  return rows;
}

export interface ApplyRow {
  key: string;
  status: 'PROCESSED' | 'NEEDS_REVIEW' | 'IGNORED' | 'FAILED' | 'SKIPPED';
  orderId?: string;
  reason?: string;
}

/**
 * «نعم، نفّذ الدمج»: the plan again, then the live door on every row that would become an order (`keys`, when given, narrows it
 * to the rows the person saw). A row that stays in review is answered SKIPPED and nothing is written for it.
 */
export async function applyWaitingMessages(companyId: string, scope: object, keys?: string[]): Promise<ApplyRow[]> {
  const plan = await planWaitingMessages(companyId, scope);
  const wanted = keys?.length ? new Set(keys) : null;
  const out: ApplyRow[] = [];
  for (const row of plan) {
    if (wanted && !wanted.has(row.key)) continue;
    if (row.kind === 'review') {
      out.push({ key: row.key, status: 'SKIPPED', reason: row.reason });
      continue;
    }
    const result = await processStoredMessage(row.baseId, { holds: false, pairWindowMs: UPSELL_RETRO_MS });
    out.push({ key: row.key, status: result.status, orderId: result.orderId, reason: result.reason });
  }
  return out;
}
