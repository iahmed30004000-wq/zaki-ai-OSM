import { hasLeftWarehouse, type StateSource } from './order-state';

/**
 * DOES POSTPONING A SHIPMENT PUT ITS GOODS BACK ON SALE?
 *
 * The owner ruled that it does: «ما زال الزبون يريده؟ الغيها ك خيار، وما
 * تحجز رصيد الا بعد ما اشيلو من التأجيل وارجعو لانشاء شحنة». A postponement
 * used to reserve the units for the whole of its length, so a hopeful
 * three-week date took stock off the shelf that a customer ready to buy
 * today could not be sold — and the person pressing the button had not
 * spoken to anybody.
 *
 * ── EXCEPT WHEN THE PARCEL IS ALREADY OUT ──
 *
 * Releasing a reservation says «these units are on the shelf again». Once
 * the waybill is printed or the parcel is standing on the pickup shelf, they
 * are not: they are packed, addressed, and physically gone from the pile
 * anybody else can be sold from. Freeing them there would not return stock,
 * it would INVENT it — the same defect `stock-consumption` records about
 * putting back units that never left, seen from the other end.
 *
 * `hasLeftWarehouse` is the existing line for exactly this question — «may
 * these units be counted available again» — and it is the one used, not a
 * second reading of the same statuses.
 *
 * Pure, so the rule can be read and tested without a database, and so the
 * route cannot hold a second opinion about it.
 */
export interface HoldReservation {
  /** True when the units go back on sale for the length of the postponement. */
  releases: boolean;
  /** One sentence, for the person who pressed the button. */
  why: string;
}

export function holdReservation(order: StateSource): HoldReservation {
  if (hasLeftWarehouse(order)) {
    return {
      releases: false,
      why: 'الطرد خرج من المستودع — بضاعتُه مُعبَّأةٌ باسم هذا الطلب ولا تعود للبيع بالتأجيل',
    };
  }
  return {
    releases: true,
    why: 'بضاعتُه تعود للبيع خلال التأجيل، وتُحجَز من جديد حين تُبنى الشحنة',
  };
}

/**
 * IS THIS ORDER WAITING OUT A HOLD THAT GAVE ITS GOODS BACK? (RV635)
 *
 * The hold door released the units of an order postponed before it left the
 * warehouse (`holdReservation` above), and takes them again only when the hold
 * is lifted — «ما تحجز رصيد الا بعد ما اشيلو من التأجيل». Any other door that
 * reserves the order's lines while that hold stands takes back what the owner
 * gave back: an approved edit of 4 → 5 on a postponed order reserved 5.
 *
 * So the question every such door asks is this one, and it is the hold door's
 * own question, not a second reading of the statuses:
 *
 *   - a hold date on the order (`shipHoldUntil`), passed or not — a date that
 *     passed did not reserve anything by itself; «أرجِعه» does;
 *   - and a parcel that had NOT left the warehouse, which is exactly the case
 *     the hold door released. A packed parcel (held from a trolley, or lifted
 *     back to the out-tray with its date set to now) kept its goods, and is
 *     answered `false`: whatever the door did before, it still does.
 */
export function holdReleasedItsStock(order: StateSource & { shipHoldUntil?: Date | string | null }): boolean {
  return !!order.shipHoldUntil && holdReservation(order).releases;
}

/** What the order's timeline and the audit log call a lifted hold — «أرجِعه» (the hold door) writes it, and so does a batch (RV880). */
export const SHIP_HOLD_RELEASED = 'SHIP_HOLD_RELEASED';

/**
 * ENTERING A BATCH ENDS THE HOLD (RV880 — the owner: «برجع للجاهز»).
 *
 * «مؤجَّلة الشحن» lists postponed parcels and lets them be ticked; «إنشاء شحنة» (`POST /api/ops/shipments`) then put one on a
 * trolley and left its `shipHoldUntil` standing — an order in a batch that still said «postponed until Thursday». The batch is the
 * decision that it goes now, so the same write that puts it on the trolley clears the date and the reason.
 *
 *   · `clears` — any hold date at all: a date already passed (a packed parcel «أرجِعه» moved to now, or one whose day came) is
 *     cleared too, so no order on a trolley carries a hold.
 *   · `lifted` — the date was still AHEAD: a postponement this batch cut short. Only then is it recorded as a lifted hold (the
 *     timeline and the audit, as «أرجِعه» records one); a passed date ended by itself, or «أرجِعه» already said so.
 *
 * It decides nothing about who may enter a batch or about stock: the door's readiness check (`assertReadyToShip`) refuses any order
 * whose units are not all reserved, so an order whose hold gave its goods back (`holdReleasedItsStock`) never gets this far.
 */
export function holdEndsInBatch(order: { shipHoldUntil?: Date | string | null }, now: Date): { clears: boolean; lifted: boolean } {
  if (!order.shipHoldUntil) return { clears: false, lifted: false };
  return { clears: true, lifted: new Date(order.shipHoldUntil).getTime() > now.getTime() };
}
