import type { SessionUser } from '@/types/auth';
import { can } from './authorization';

/**
 * WHO MAY SEE WHAT A THING COST US.
 *
 * `products.view` is held by the moderator, the confirmation agent and the
 * follow-up agent — people who must see what a product IS and what it
 * SELLS for, because they are on the phone with a customer. It was also
 * handing them every batch's manufacturing, packaging and raw-material
 * cost, the total production cost and the average cost per unit: the
 * company's margin on every line it sells, to anyone who could open the
 * products screen or call the endpoint.
 *
 * The rule is not new — the inventory route already gates cost behind
 * `inventory.view`, and production behind `production.manage`. This states
 * that rule once so the product list cannot answer it differently, which
 * is how the two came to disagree in the first place.
 *
 * A PRICE IS NOT A COST. What the customer pays is on the page the
 * customer reads; nothing here hides it.
 */
export function maySeeCost(user: SessionUser): boolean {
  // ONE KEY (perm-plan PR-10, D3). This was an OR of five — the stock, the production and the finance screens' keys — so the
  // owner could not take the cost away from the warehouse and keep the shelf. The migration
  // 20261030170000_costs_insights_keys gave `costs.view` to everybody who held any of the five, so nobody lost a figure
  // on the day; from then on one tick takes it away. A visibility key: the screen still opens on its own key.
  return can(user, 'costs.view');
}

/** The batch fields that say what it cost — dropped for everybody else. */
const COST_FIELDS = [
  'totalProductionCost',
  'costPerUnit',
  'manufacturingCost',
  'packagingCost',
  'rawMaterialCost',
  'otherCosts',
] as const;

/**
 * A batch as a caller who may not see cost should receive it: quantities
 * and dates, no money.
 *
 * Omitted, not zeroed. A zero is a claim — «this cost nothing» — and a
 * screen that prints it teaches somebody a false figure. An absent field
 * is a screen that shows no column at all.
 */
export function withoutCost<T extends Record<string, unknown>>(batch: T): Omit<T, (typeof COST_FIELDS)[number]> {
  const out = { ...batch };
  for (const field of COST_FIELDS) delete (out as Record<string, unknown>)[field];
  return out;
}
