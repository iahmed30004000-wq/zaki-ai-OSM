import { ORDER_COST_FIELDS } from '@/lib/order-projection';

/**
 * WHAT AN ORDER'S MONEY SNAPSHOT SHOWS TO A SETTLEMENT READER (perm-plan PR-9, the leftover of PR-2a).
 *
 * `GET /api/orders/:id/finance` opens to `finance.view` OR `settlement.view`. The second key belongs to the person who
 * follows the courier's money — what the customer owes, what was settled, what was refunded — and the snapshot handed
 * her the shop's whole margin on the order too: the cost of goods, the packaging, advertising and other costs, the gross
 * and net profit, the courier's fee, and a ledger that lists every cost edit and every commission with the name of who
 * wrote it.
 *
 * The door stays open to her (nobody loses it), but what comes back is the customer's bill and the settlement's own
 * figures. The cost and the profit are the finance key's, as on every other money screen (`maySeeOrderCost`).
 *
 * The courier's fee (`shippingCost`) is a cost to the shop, so it goes with the rest.
 */

/** The ledger rows a settlement reader may see: the cash side, never the cost or the commission side. */
export const SETTLEMENT_LEDGER_TYPES: readonly string[] = ['SETTLEMENT', 'REFUND'];

/** The snapshot's own cost columns: the order's cost fields, plus the courier's fee. */
export const SNAPSHOT_COST_FIELDS: readonly string[] = [...ORDER_COST_FIELDS, 'shippingCost'];

type Row = Record<string, unknown>;

/** The snapshot as a settlement reader without the finance key may read it: no cost, no profit, only the cash ledger. */
export function settlementSightOfOrderFinance<T extends Row>(snapshot: T | null): T | null {
  if (!snapshot) return snapshot;
  const out: Row = { ...snapshot };
  for (const f of SNAPSHOT_COST_FIELDS) delete out[f];
  if (Array.isArray(out.financialTransactions)) {
    out.financialTransactions = (out.financialTransactions as Row[]).filter((t) => SETTLEMENT_LEDGER_TYPES.includes(String(t.type)));
  }
  return out as T;
}
