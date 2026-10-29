import { describe, expect, it } from 'vitest';
import { assertCancellable, assertVoidable, hasLeftWarehouse, type StateSource } from './order-state';
import { beforeHandoverReturn, isValidShippingTransition, RETURN_BEFORE_HANDOVER_AR } from './shipping-workflow';
import { cancelVerdict } from './shipment-cancel';

/**
 * When do an order's goods come back to the shelf?
 *
 * Before the parcel leaves, cancelling frees them: nothing physical moved.
 * After it leaves, they come back only through the returns door, counted.
 *
 * The line between those used to sit at SHIPPED — but a parcel is packed,
 * labelled and handed to the courier a stage earlier. In that window an
 * order could be cancelled, its reservation dropped, and its units counted
 * as available again while they were sitting in a van. These hold the line
 * where the goods actually stop being ours to take back.
 *
 * ── M6 (28/10): TWO QUESTIONS THAT WERE ONE ──
 *
 * The 28/09 ruling «لحظةَ طباعة البوليصة» answered both «may it be CANCELLED?»
 * and «are its goods back on the shelf?» with the printed waybill. The owner
 * overturned the FIRST for cancelling and postponing only («الغاء و التأجيل
 * لغاية ما اضغط اغلاق الشحنة»): until the press of «إغلاق الشحنة — سُلّمت
 * للشركة» the box is on our floor and can be opened. The SECOND stands: a
 * labelled parcel's units are packed under its name, so they come back only on
 * a person's word (`ATTESTATION_AR`), and a VOID is still refused.
 *
 * (old → new) The two tests that said «a printed waybill closes cancellation»
 * and «waiting for pickup counts as gone» asserted the 28/09 ruling on
 * `assertCancellable`. They now assert it where it still holds (stock, VOID,
 * `hasLeftWarehouse`) and assert the new line on `cancelVerdict`.
 */

const order = (over: Partial<StateSource> = {}): StateSource => ({
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY',
  ...over,
});

describe('while the parcel is still ours', () => {
  it('may be cancelled at every stage before it is committed', () => {
    for (const shippingStatus of ['NOT_READY', 'READY_FOR_SHIPPING', 'PACKING']) {
      expect(assertCancellable(order({ shippingStatus })).allowed, shippingStatus).toBe(true);
    }
  });

  it('may be voided too, while nothing has physically moved', () => {
    expect(assertVoidable(order({ shippingStatus: 'PACKING' })).allowed).toBe(true);
  });
});

/** The trolley the parcel sits on: none, one still being filled, or one that was pressed. */
const verdict = (o: StateSource, batchStatus: string | null = null) =>
  cancelVerdict({
    confirmationStatus: o.confirmationStatus,
    shippingStatus: o.shippingStatus,
    shippedAt: o.shippedAt ?? null,
    labelPrintedAt: o.labelPrintedAt ?? null,
    shippingBatchId: batchStatus ? 'b1' : null,
    batchStatus,
  });

describe('once it is committed to a courier — the STOCK line (28/09, kept)', () => {
  it('a printed waybill still commits the goods, before the status says SHIPPED', () => {
    // The exact case that leaked: labelled and handed over, still "PACKING".
    const committed = order({ shippingStatus: 'PACKING', labelPrintedAt: new Date() });
    expect(hasLeftWarehouse(committed)).toBe(true);
    // A void is not a cancel: nothing may be undone for an order whose goods are packed.
    expect(assertVoidable(committed).allowed).toBe(false);
    // And the strict, 28/09 reading of «may it be cancelled?» still says no — it is kept
    // for readers that mean it; no cancel door asks it any more.
    expect(assertCancellable(committed).allowed).toBe(false);
  });

  it('waiting for pickup counts as gone, waybill or not — for the stock', () => {
    expect(hasLeftWarehouse(order({ shippingStatus: 'READY_FOR_PICKUP' }))).toBe(true);
    expect(assertVoidable(order({ shippingStatus: 'READY_FOR_PICKUP' })).allowed).toBe(false);
  });

  it('stays closed at every stage after it left', () => {
    for (const shippingStatus of ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED']) {
      expect(assertCancellable(order({ shippingStatus })).allowed, shippingStatus).toBe(false);
      expect(verdict(order({ shippingStatus })).allowed, shippingStatus).toBe(false);
    }
  });

  it('says where the goods come back from, instead of only refusing', () => {
    const msg = assertCancellable(order({ shippingStatus: 'READY_FOR_PICKUP' })).message ?? '';
    expect(msg).toContain('المرتجع');
    const refused = verdict(order({ shippingStatus: 'SHIPPED' }));
    expect(refused.allowed ? '' : refused.message).toContain('المرتجع');
  });

  it('treats a shipped timestamp as final even if the status was rolled back', () => {
    expect(hasLeftWarehouse(order({ shippingStatus: 'PACKING', shippedAt: new Date() }))).toBe(true);
    expect(verdict(order({ shippingStatus: 'PACKING', shippedAt: new Date() })).allowed).toBe(false);
  });
});

describe('the CANCEL line (M6) — the press of «إغلاق الشحنة — سُلّمت للشركة»', () => {
  it('a printed waybill on our own floor can be cancelled — on the word of the person who opens the box', () => {
    const committed = order({ shippingStatus: 'PACKING', labelPrintedAt: new Date() });
    expect(verdict(committed)).toEqual({ allowed: true, needsAttestation: true });
  });

  it('so can a parcel on the pickup shelf, and on a trolley still being filled', () => {
    expect(verdict(order({ shippingStatus: 'READY_FOR_PICKUP' }))).toEqual({ allowed: true, needsAttestation: true });
    expect(verdict(order({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() }), 'READY'))
      .toEqual({ allowed: true, needsAttestation: true });
  });

  it('but not once the trolley was pressed — even if the parcel’s own status never moved', () => {
    const stillWaiting = order({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });
    for (const status of ['SHIPPED', 'CLOSED']) {
      expect(verdict(stillWaiting, status).allowed, status).toBe(false);
    }
  });

  it('NEGATIVE: an unpacked order asks for no word at all', () => {
    for (const shippingStatus of ['NOT_READY', 'READY_FOR_SHIPPING']) {
      expect(verdict(order({ shippingStatus })), shippingStatus).toEqual({ allowed: true, needsAttestation: false });
    }
  });

  it('FAILS CLOSED: a trolley named but unreadable is not assumed open', () => {
    const out = cancelVerdict({
      confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null,
      labelPrintedAt: null, shippingBatchId: 'b1', batchStatus: null,
    });
    expect(out).toMatchObject({ allowed: false, code: 'UNKNOWN_BATCH' });
  });

  it('and the old guard refuses ANY batched order, whatever it knows of the trolley', () => {
    expect(assertCancellable({ ...order(), shippingBatchId: 'b1' })).toMatchObject({ allowed: false, code: 'IN_BATCH' });
    // The negative: no trolley, no new refusal.
    expect(assertCancellable({ ...order(), shippingBatchId: null }).allowed).toBe(true);
  });
});

describe('the way back', () => {
  /*
   * (old → new, 28/10 «قبل التسليم: نفس الطلب») The first case said «a labelled parcel
   * that never moved can be returned without faking a journey», and asserted
   * READY_FOR_PICKUP → RETURN_REQUESTED is VALID. It is now INVALID, and the reason is
   * the owner's M6 line: a parcel the company never took has nothing to return. The
   * transition made a fake return — on the returns desk, in the tracking alerts, in the
   * customer's return rate — for a box that never left the building. The three things
   * that fit before the handover are cancel, hold and move to another company as the
   * same order; the refusal says so. The other two cases below are unchanged.
   */
  it('a parcel on our own floor has nothing to return: the transition is REMOVED, and marked', () => {
    expect(isValidShippingTransition('READY_FOR_PICKUP', 'RETURN_REQUESTED')).toBe(false);
    expect(beforeHandoverReturn('READY_FOR_PICKUP', 'RETURN_REQUESTED')).toBe(true);
    expect(RETURN_BEFORE_HANDOVER_AR).toContain('ألغِ الطلب');
    expect(RETURN_BEFORE_HANDOVER_AR).toContain('أجّل شحنه');
    expect(RETURN_BEFORE_HANDOVER_AR).toContain('حوّله لشركة تانية');
  });

  it('NEGATIVE: nothing else was removed — the parcel still goes out, and the ones in transit still come back', () => {
    expect(isValidShippingTransition('READY_FOR_PICKUP', 'SHIPPED')).toBe(true);
    expect(isValidShippingTransition('FAILED_DELIVERY', 'RETURN_REQUESTED')).toBe(true);
    expect(beforeHandoverReturn('FAILED_DELIVERY', 'RETURN_REQUESTED')).toBe(false);
    expect(beforeHandoverReturn('READY_FOR_PICKUP', 'SHIPPED')).toBe(false);
  });

  it('still cannot jump straight to delivered from the shelf', () => {
    expect(isValidShippingTransition('READY_FOR_PICKUP', 'DELIVERED')).toBe(false);
  });

  it('ends at RETURNED, where the count puts the goods back', () => {
    expect(isValidShippingTransition('RETURN_REQUESTED', 'RETURNED')).toBe(true);
  });
});
