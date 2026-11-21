import { roundMinor } from './money';

/**
 * «بضاعة بالطريق» — WHAT IS ON THE ROAD, AND WHAT IT COST (the warehouse plan, request W7c). Pure: no database, no
 * session, no clock. The transfers list door (`/api/inventory/transfers`) hands it the transfers that are on the road
 * (status SENT) and the viewer; the screen draws the answer as it comes — it adds nothing up.
 *
 *   ON THE ROAD = sent and not yet received. A request to another country still waiting for the owner's press has not
 *   left (nothing moved), so it is not on the road; a shortfall waiting for its approval was received.
 *
 *   INSIDE ONE STORE the units on the road are still that store's stock (their batch travels with them, at its cost), so
 *   no cost is counted here for them: they are counted as transfers only.
 *
 *   ACROSS STORES the goods exist on the document only between send and receipt: their value is what left the source,
 *   kept on each line (`costOut`, in the SOURCE store's currency). The report adds it up PER SOURCE STORE — two stores of
 *   two countries keep two currencies, and two currencies are never added together — rounded once to that currency's
 *   minor unit.
 *
 *   WHO SEES THE COST: a holder of `costs.view` only. And the receipt stays blind: the cost that left ÷ a known unit cost
 *   would tell the sent figure, so a transfer this viewer may RECEIVE (she holds the receive key and did not send it) is
 *   counted, but its cost is held back — the answer says how many were held back, never their value.
 */

export interface RoadCurrency {
  code: string;
  minorUnit: number;
}

export interface RoadTransfer {
  id: string;
  kind: string;
  status: string;
  /** The source store (whose currency `costOut` is in). */
  storeId: string;
  sentById: string;
  lines: readonly { costOut?: number | null }[];
}

export interface RoadViewer {
  id: string;
  /** `cost-visibility.maySeeCost`. */
  seesCost: boolean;
  /** Holds `inventory.transfer_receive`. */
  mayReceive: boolean;
}

export interface RoadTotal {
  storeId: string;
  storeName: string | null;
  currency: RoadCurrency | null;
  /** How many transfers across stores out of this store are on the road and counted in `cost`. */
  transfers: number;
  /** Σ of what left, rounded once to the currency's minor unit (2 when the currency is unknown). */
  cost: number;
}

export interface RoadReport {
  /** Every transfer on the road that this list door shows (inside the store and across). */
  onTheRoad: number;
  /** Of them, inside one store. */
  internal: number;
  /** Of them, to or from another store. */
  across: number;
  /** The value of the ones across, per source store. Null for a viewer who may not see cost. */
  totals: RoadTotal[] | null;
  /** Transfers across whose cost is held back from this viewer (she may receive them; the count is blind). */
  heldBack: number;
}

const isAcrossKind = (kind: string) => kind === 'BETWEEN_STORES' || kind === 'BETWEEN_COUNTRIES';

/** May this viewer be told what this transfer on the road cost? */
export function roadCostShown(t: Pick<RoadTransfer, 'sentById'>, viewer: RoadViewer): boolean {
  if (!viewer.seesCost) return false;
  return t.sentById === viewer.id || !viewer.mayReceive;
}

export function roadReport(
  rows: readonly RoadTransfer[],
  viewer: RoadViewer,
  storeOf: (storeId: string) => { name: string | null; currency: RoadCurrency | null }
): RoadReport {
  const road = rows.filter((r) => r.status === 'SENT');
  const across = road.filter((r) => isAcrossKind(r.kind));
  let heldBack = 0;
  const sums = new Map<string, { transfers: number; cost: number }>();
  if (viewer.seesCost) {
    for (const t of across) {
      if (!roadCostShown(t, viewer)) {
        heldBack += 1;
        continue;
      }
      const s = sums.get(t.storeId) ?? { transfers: 0, cost: 0 };
      s.transfers += 1;
      for (const l of t.lines) s.cost += l.costOut ?? 0;
      sums.set(t.storeId, s);
    }
  }
  return {
    onTheRoad: road.length,
    internal: road.length - across.length,
    across: across.length,
    totals: viewer.seesCost
      ? [...sums.entries()].map(([storeId, s]) => {
          const store = storeOf(storeId);
          return {
            storeId,
            storeName: store.name,
            currency: store.currency,
            transfers: s.transfers,
            cost: roundMinor(s.cost, store.currency?.minorUnit ?? 2),
          };
        })
      : null,
    heldBack,
  };
}
