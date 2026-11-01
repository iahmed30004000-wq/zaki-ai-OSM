import { describe, expect, it } from 'vitest';
import { offersSayDeliveryIncluded } from './offer-delivery';

/**
 * WHAT THE OFFERS ON AN ORDER SAY ABOUT DELIVERY (the owner, 1/11: «بدي اترك مجال … أحدد إذا شامل ولا لأ بظبط»).
 *
 * The reader is pure and shared by every door that writes an order, so its whole table is held here. `undefined` is silence — the
 * store's policy decides — and is what a line with no offer contributes.
 */
describe('offersSayDeliveryIncluded', () => {
  const T = true;
  const F = false;
  const _ = undefined;

  it.each([
    // [flags, answer]
    [[], _], // no lines: nothing is said
    [[_], _], // one line, no offer
    [[T], T],
    [[F], F], // the owner's «no» on the only offer
    [[F, F], F], // every line a «no»
    [[F, F, F], F],
    [[T, F], T], // ANY yes makes the whole order include delivery (one parcel, one fee or none)
    [[F, T], T],
    [[T, T], T],
    [[F, _], _], // a line with no offer: the store speaks for it, so the order is the store's
    [[_, F], _],
    [[_, _], _],
    [[T, _], T], // …unless another line already says yes
    [[_, T, F], T],
    [[null], _], // a null is silence too (an offer id that matched nothing)
    [[F, null], _],
    [[null, T], T],
  ] as Array<[Array<boolean | null | undefined>, boolean | undefined]>)('%j → %s', (flags, answer) => {
    expect(offersSayDeliveryIncluded(flags)).toBe(answer);
  });

  it('NEGATIVE: «no» is never invented — an empty basket, and a basket with a line that has no offer, never answer false', () => {
    expect(offersSayDeliveryIncluded([])).toBeUndefined();
    expect(offersSayDeliveryIncluded([false, undefined])).toBeUndefined();
    expect(offersSayDeliveryIncluded([false, null])).toBeUndefined();
  });

  it('does not mutate what it is given, and does not depend on the order of the lines', () => {
    const flags = [false, true, undefined];
    const copy = [...flags];
    expect(offersSayDeliveryIncluded(flags)).toBe(true);
    expect(flags).toEqual(copy);
    expect(offersSayDeliveryIncluded([...flags].reverse())).toBe(true);
  });
});
