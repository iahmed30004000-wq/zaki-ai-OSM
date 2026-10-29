import { describe, expect, it } from 'vitest';
import { IN_FLIGHT_STATUSES, isInFlight, transitOf, transitStatus } from './transit';
import {
  MATCHES,
  NOT_LATE,
  URGENCIES,
  byUrgency,
  canCollect,
  expectsBarcode,
  matchesChip,
  notLate,
  trackingUrgency,
  type TrackingFacts,
} from './tracking-priority';
import { trackingAlert } from './tracking-alert';
import { repoFile, stripComments } from './guard-source';

/**
 * THE CLOCK STOPS AT THE DOOR — the pure rules under the follow-up board.
 *
 * `transitOf` is the one place that says how long a parcel was out and whether that is late; the tracking list, the
 * page's rows and the day's card all ask it. `MATCHES` is the one place that says which conditions a row meets.
 */

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

describe('transitStatus — the clock', () => {
  it('runs to now for a parcel still on the road', () => {
    expect(transitStatus(ago(10), 3, NOW)).toEqual({ days: 10, late: true });
    expect(transitStatus(ago(3), 3, NOW)).toEqual({ days: 3, late: false });
  });

  it('stops at the end date, and an ended journey is never late', () => {
    expect(transitStatus(ago(40), 3, NOW, ago(30))).toEqual({ days: 10, late: false });
  });

  it('never goes below zero when the end is dated before the start', () => {
    expect(transitStatus(ago(5), 3, NOW, ago(9))).toEqual({ days: 0, late: false });
  });

  it('an end date in the future is not believed: the clock does not run past today', () => {
    expect(transitStatus(ago(2), 3, NOW, new Date(NOW.getTime() + 9 * DAY)).days).toBe(2);
  });

  it('a garbage end date is the same as none', () => {
    expect(transitStatus(ago(10), 3, NOW, 'not a date')).toEqual({ days: 10, late: true });
  });

  it('no shipping date, no clock', () => {
    expect(transitStatus(null, 3, NOW, ago(1))).toEqual({ days: null, late: false });
  });

  it('a zero threshold means «never late»', () => {
    expect(transitStatus(ago(50), 0, NOW).late).toBe(false);
  });
});

describe('transitOf — the one answer for an order', () => {
  const o = (over: Partial<Parameters<typeof transitOf>[0]> = {}) => ({ shippingStatus: 'SHIPPED', shippedAt: ago(10), ...over });

  it('on the road and past its time: late, with the days', () => {
    expect(transitOf(o(), 3, NOW)).toEqual({ days: 10, late: true, inFlight: true });
  });

  it('delivered: the days stop at the delivery, and it is not late even if the trip was long', () => {
    expect(transitOf(o({ shippingStatus: 'DELIVERED', shippedAt: ago(40), deliveredAt: ago(30) }), 3, NOW)).toEqual({
      days: 10, late: false, inFlight: false,
    });
  });

  it('delivered before shipped-plus-threshold: not late', () => {
    expect(transitOf(o({ shippingStatus: 'DELIVERED', shippedAt: ago(10), deliveredAt: ago(9) }), 3, NOW).late).toBe(false);
  });

  it('returned: stops at the return', () => {
    expect(transitOf(o({ shippingStatus: 'RETURNED', shippedAt: ago(20), returnedAt: ago(15) }), 3, NOW)).toMatchObject({ days: 5, late: false });
  });

  it('both dates: the journey ended at the first of them', () => {
    expect(
      transitOf(o({ shippingStatus: 'PARTIALLY_DELIVERED', shippedAt: ago(20), deliveredAt: ago(15), returnedAt: ago(5) }), 3, NOW).days
    ).toBe(5);
  });

  it('an arrived state with no date (the sheet import): no days, not late — never a clock to today', () => {
    expect(transitOf(o({ shippingStatus: 'DELIVERED' }), 3, NOW)).toEqual({ days: null, late: false, inFlight: false });
  });

  it('a date ends the journey even when the state still says it is out', () => {
    expect(transitOf(o({ deliveredAt: ago(8) }), 3, NOW)).toMatchObject({ days: 2, late: false, inFlight: false });
  });

  it('never shipped: nothing to count', () => {
    expect(transitOf(o({ shippingStatus: 'NOT_READY', shippedAt: null }), 3, NOW)).toEqual({ days: null, late: false, inFlight: false });
  });

  it('the roadside states are exactly the ones the follow-up opens on', () => {
    expect([...IN_FLIGHT_STATUSES].sort()).toEqual(
      ['FAILED_DELIVERY', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'RETURN_REQUESTED', 'SHIPPED']
    );
    // And the door's own question names the same five, so what it brings back and what the clock judges cannot drift.
    const route = stripComments(repoFile('src/app/api/ops/tracking/route.ts'));
    const asked = /const IN_FLIGHT = \[([^\]]*)\]/.exec(route)![1].match(/[A-Z_]+/g)!;
    expect([...asked].sort()).toEqual([...IN_FLIGHT_STATUSES].sort());
    for (const s of ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED', 'NOT_READY', 'PACKING']) {
      expect(isInFlight({ shippingStatus: s }), s).toBe(false);
    }
  });
});

describe('the conditions — on the road only', () => {
  const row = (over: Partial<TrackingFacts> = {}): TrackingFacts => ({
    shippingStatus: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION', trackingNumber: 'AR-1', daysInTransit: 1, late: false, alert: null, ...over,
  });

  it('LATE: a delivered or returned row never matches, even if something upstream said late', () => {
    expect(MATCHES.LATE(row({ late: true }))).toBe(true);
    expect(MATCHES.LATE(row({ late: true, shippingStatus: 'DELIVERED' }))).toBe(false);
    expect(MATCHES.LATE(row({ late: true, shippingStatus: 'RETURNED' }))).toBe(false);
    expect(MATCHES.LATE(row({ late: true, deliveredAt: ago(1) }))).toBe(false);
  });

  it('NO_BARCODE: an API company’s parcel on the road, yes; a manual company’s, no; an arrived one, no', () => {
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null, barcodeExpected: true }))).toBe(true);
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null, barcodeExpected: false }))).toBe(false);
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null, shippingStatus: 'DELIVERED' }))).toBe(false);
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null, returnedAt: ago(1) }))).toBe(false);
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null, shippingStatus: 'NOT_READY' }))).toBe(false);
  });

  it('NO_BARCODE: a row that does not say is judged as before (the barcode is expected)', () => {
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null }))).toBe(true);
  });

  it('alerts: a live one counts only while the parcel is out', () => {
    const alert = { kind: 'CANCELLED' as const, acknowledged: false };
    expect(MATCHES.CANCELLED(row({ alert }))).toBe(true);
    expect(MATCHES.CANCELLED(row({ alert, shippingStatus: 'DELIVERED' }))).toBe(false);
    expect(MATCHES.CHANGED(row({ alert: { kind: 'CHANGED', acknowledged: false }, returnedAt: ago(1) }))).toBe(false);
  });

  it('a delivered row is owed money and nothing else: its reason is COLLECT, not LATE or NO_BARCODE', () => {
    expect(
      trackingUrgency(row({ shippingStatus: 'DELIVERED', late: true, trackingNumber: null, alert: { kind: 'CANCELLED', acknowledged: false } }))
    ).toBe('COLLECT');
  });

  it('«غير متأخرة» is a chip, never a reason: it is not one of the ranked conditions', () => {
    expect(URGENCIES).not.toContain(NOT_LATE);
    expect(trackingUrgency(row())).toBe('NONE');
  });

  it('«غير متأخرة»: on the road and not late', () => {
    expect(notLate(row())).toBe(true);
    expect(notLate(row({ late: true }))).toBe(false);
    expect(notLate(row({ shippingStatus: 'DELIVERED' }))).toBe(false);
    expect(notLate(row({ shippingStatus: 'FAILED_DELIVERY' }))).toBe(true);
  });

  it('a chip is its own predicate: the seven are MATCHES, the eighth is notLate', () => {
    expect(matchesChip('LATE')).toBe(MATCHES.LATE);
    expect(matchesChip(NOT_LATE)).toBe(notLate);
  });

  it('only a company with the API on and an adapter owes a barcode', () => {
    expect(expectsBarcode({ apiEnabled: true, adapterCode: 'logestechs' })).toBe(true);
    expect(expectsBarcode({ apiEnabled: true, adapterCode: null })).toBe(false);
    expect(expectsBarcode({ apiEnabled: false, adapterCode: 'logestechs' })).toBe(false);
    expect(expectsBarcode({})).toBe(false);
    expect(expectsBarcode(null)).toBe(false);
    expect(expectsBarcode(undefined)).toBe(false);
  });

  it('the collect rule is untouched by any of it', () => {
    expect(canCollect(row({ shippingStatus: 'DELIVERED' }))).toBe(true);
    expect(canCollect(row({ shippingStatus: 'PARTIALLY_DELIVERED', returnedAt: ago(1) }))).toBe(true);
  });
});

describe('the owed rows — the longest-delivered first', () => {
  const owed = (deliveredAt: Date | null, daysInTransit = 1): TrackingFacts => ({
    shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', trackingNumber: 'X', daysInTransit, late: false, deliveredAt,
  });

  it('sorts by delivery date, the oldest first, the undated last', () => {
    const list = [owed(ago(2)), owed(null), owed(ago(20)), owed(ago(9))];
    expect(list.slice().sort(byUrgency).map((r) => r.deliveredAt)).toEqual([list[2].deliveredAt, list[3].deliveredAt, list[0].deliveredAt, null]);
  });

  it('and ignores the days of the trip, which say how long it took, not how long it has been owed', () => {
    const slowTripNewDelivery = owed(ago(1), 30);
    const quickTripOldDelivery = owed(ago(30), 1);
    expect([slowTripNewDelivery, quickTripOldDelivery].sort(byUrgency)[0]).toBe(quickTripOldDelivery);
  });

  it('equal delivery dates keep the order they arrived in', () => {
    const when = ago(5);
    const a = owed(when);
    const b = owed(when);
    expect(byUrgency(a, b)).toBe(0);
  });

  it('accepts the dates as the wire sends them (text)', () => {
    expect([owed(ago(1).toISOString() as unknown as Date), owed(ago(9).toISOString() as unknown as Date)].sort(byUrgency)[0].deliveredAt).toBe(
      ago(9).toISOString()
    );
  });
});

describe('trackingAlert — only while the parcel is out', () => {
  const dead = { confirmationStatus: 'CANCELLED', cancelledAt: ago(2), changeAppliedAt: null, acknowledgedAt: null };

  it('says it for a parcel on the road (and when nobody said — the way it always did)', () => {
    expect(trackingAlert(dead)?.kind).toBe('CANCELLED');
    expect(trackingAlert({ ...dead, inFlight: true })?.kind).toBe('CANCELLED');
  });

  it('says nothing for a parcel that arrived or came back', () => {
    expect(trackingAlert({ ...dead, inFlight: false })).toBeNull();
    expect(trackingAlert({ ...dead, confirmationStatus: 'CONFIRMED', changeAppliedAt: ago(1), inFlight: false })).toBeNull();
  });
});
