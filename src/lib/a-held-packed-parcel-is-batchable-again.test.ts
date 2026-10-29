import { describe, expect, it } from 'vitest';
import { BATCHABLE_SHIPPING, HELD_PACKED_PARCEL, WAITING_FOR_A_TROLLEY, whyNotBatchable } from './batching-guard';
import { repoFile, stripComments } from './guard-source';

/**
 * A PACKED PARCEL THAT «أجّل الشحن» TOOK OFF A TROLLEY KEEPS ITS STATUS —
 * READY_FOR_PICKUP, which IS the fact «the box is packed» — so the list and the
 * batch creation have to know it by its hold date, or it is lost.
 */
describe('batching a postponed packed parcel', () => {
  const base = { shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: null, shippedAt: null };

  it('is allowed only with the hold date', () => {
    expect(whyNotBatchable({ ...base, shipHoldUntil: new Date() })).toBeNull();
  });

  it('NEGATIVE: a parcel an agent handed back (no hold date) is still not batchable by the creation door', () => {
    expect(whyNotBatchable({ ...base })).toBeTruthy();
    expect(whyNotBatchable({ ...base, shipHoldUntil: null })).toBeTruthy();
  });

  it('and never when it is on a trolley, or has shipped', () => {
    expect(whyNotBatchable({ ...base, shipHoldUntil: new Date(), shippingBatchId: 'b1' })).toBeTruthy();
    expect(whyNotBatchable({ ...base, shipHoldUntil: new Date(), shippedAt: new Date(), shippingStatus: 'SHIPPED' })).toBeTruthy();
  });

  it('the statuses that wait for a trolley are unchanged', () => {
    expect([...WAITING_FOR_A_TROLLEY]).toEqual([...BATCHABLE_SHIPPING]);
    expect([...BATCHABLE_SHIPPING]).toEqual(['NOT_READY', 'PACKING', 'READY_FOR_SHIPPING']);
  });
});

describe('the shipment list offers it', () => {
  const route = () => stripComments(repoFile('src/app/api/ops/shipments/route.ts'));

  it('as its own branch, in the list and in the held count', () => {
    expect(HELD_PACKED_PARCEL).toMatchObject({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: null });
    const src = route();
    expect((src.match(/HELD_PACKED_PARCEL/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(src).toMatch(/\.\.\.HELD_PACKED_PARCEL, shipHoldUntil: \{ lte: new Date\(\) \}/);
  });

  it('and the creation write allows READY_FOR_PICKUP only for a parcel that carries a hold date', () => {
    expect(route()).toMatch(/\.\.\.\(order\.shipHoldUntil \? \['READY_FOR_PICKUP'\] : \[\]\)/);
  });
});
