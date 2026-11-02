import { describe, expect, it } from 'vitest';
import { holdReleasedItsStock, holdReservation } from './shipment-hold';
import { hasLeftWarehouse, type StateSource } from './order-state';

/**
 * POSTPONING PUTS THE GOODS BACK ON SALE — unless they are already packed.
 *
 * The owner's ruling: «ما زال الزبون يريده؟ الغيها ك خيار، وما تحجز رصيد الا
 * بعد ما اشيلو من التأجيل وارجعو لانشاء شحنة». What this file guards is the
 * one exception, because it is the one that would otherwise invent stock.
 */

const order = (over: Partial<StateSource> = {}): StateSource =>
  ({
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'READY_FOR_SHIPPING',
    shippedAt: null,
    labelPrintedAt: null,
    ...over,
  }) as StateSource;

describe('holdReservation', () => {
  it('frees the goods of an order still sitting in the warehouse', () => {
    const r = holdReservation(order());
    expect(r.releases).toBe(true);
    expect(r.why).toContain('تعود للبيع');
  });

  /**
   * THE EXCEPTION, AND WHY IT IS NOT AN OPINION.
   *
   * Releasing a reservation says «these units are on the shelf again». Once
   * the waybill is printed they are packed under this order's name and are
   * on no shelf at all, so freeing them would not restore stock — it would
   * invent it, and the next customer would be promised goods that are in a
   * sealed parcel.
   */
  it('keeps them once the waybill is printed', () => {
    const r = holdReservation(order({ labelPrintedAt: new Date() }));
    expect(r.releases).toBe(false);
    expect(r.why).toContain('خرج من المستودع');
  });

  it('and once the parcel has shipped', () => {
    expect(holdReservation(order({ shippedAt: new Date(), shippingStatus: 'SHIPPED' })).releases).toBe(false);
  });

  it('and once it is standing on the pickup shelf', () => {
    expect(holdReservation(order({ shippingStatus: 'READY_FOR_PICKUP' })).releases).toBe(false);
  });

  /**
   * IT IS THE SAME LINE, NOT A SECOND READING OF IT.
   *
   * `hasLeftWarehouse` already answers «may these units be counted
   * available again». A copy of that reasoning here would drift from it,
   * and the two would disagree about a printed label on some Tuesday.
   */
  it('answers exactly the warehouse line, never its own version of it', () => {
    for (const o of [
      order(),
      order({ labelPrintedAt: new Date() }),
      order({ shippedAt: new Date() }),
      order({ shippingStatus: 'READY_FOR_PICKUP' }),
      order({ shippingStatus: 'DELIVERED' }),
    ]) {
      expect(holdReservation(o).releases).toBe(!hasLeftWarehouse(o));
    }
  });

  it('always says why, so the message on screen is never a bare refusal', () => {
    expect(holdReservation(order()).why.length).toBeGreaterThan(20);
    expect(holdReservation(order({ shippedAt: new Date() })).why.length).toBeGreaterThan(20);
  });
});

/**
 * THE QUESTION THE OTHER DOORS ASK BEFORE THEY RESERVE (RV635): is this order waiting out a hold that gave its goods back?
 * The hold door's own answer — a hold date, and a parcel `holdReservation` would release — not a second reading of it.
 */
describe('holdReleasedItsStock', () => {
  const soon = new Date(Date.now() + 86_400_000);

  it('a postponed order still in the warehouse: yes — its goods wait for the hold to be lifted', () => {
    expect(holdReleasedItsStock({ ...order(), shipHoldUntil: soon })).toBe(true);
    expect(holdReleasedItsStock({ ...order({ shippingStatus: 'NOT_READY' }), shipHoldUntil: soon.toISOString() })).toBe(true);
  });

  it('a hold date that passed with nobody lifting it: still yes — a date reserves nothing by itself', () => {
    expect(holdReleasedItsStock({ ...order(), shipHoldUntil: new Date(Date.now() - 86_400_000) })).toBe(true);
  });

  it('no hold: no', () => {
    expect(holdReleasedItsStock({ ...order(), shipHoldUntil: null })).toBe(false);
    expect(holdReleasedItsStock(order())).toBe(false);
  });

  it('a held parcel that kept its goods (packed, labelled, gone): no — whatever reserved it before still does', () => {
    for (const o of [
      order({ shippingStatus: 'READY_FOR_PICKUP' }),
      order({ labelPrintedAt: new Date() }),
      order({ shippedAt: new Date() }),
    ]) {
      expect(holdReleasedItsStock({ ...o, shipHoldUntil: soon })).toBe(false);
    }
  });

  it('agrees with the hold door over every combination: held AND released by `holdReservation`', () => {
    for (const shippingStatus of ['NOT_READY', 'PACKING', 'READY_FOR_SHIPPING', 'READY_FOR_PICKUP', 'SHIPPED']) {
      for (const labelPrintedAt of [null, new Date()]) {
        for (const shipHoldUntil of [null, soon]) {
          const o = { ...order({ shippingStatus, labelPrintedAt }), shipHoldUntil };
          expect(holdReleasedItsStock(o)).toBe(!!shipHoldUntil && holdReservation(o).releases);
        }
      }
    }
  });
});
