import { describe, expect, it } from 'vitest';
import { ON_OPEN_TROLLEY, ON_TROLLEY_AR, SEALED_BATCH_STATUSES, onOpenTrolley } from './order-seal';
import { CHANGE_INTENTS, carryOut, refusalFor } from './change-request-intent';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OWNER'S RULING 4/11 — «مجرد ما الطلبات تترحل ع الباتش ما حد يقدر يلغي أي شي، ولا يترحل طلب الغاء او طلب
 * تأجيل او تعديل، عشان اقدر اغلق الشحنة».
 *
 * ORD-2026-1584 sat on a READY trolley with an approved, never-carried-out cancel, and the press «إغلاق الشحنة» refused
 * the whole trolley for it. The ONE predicate every door and every screen asks is `onOpenTrolley`: the order names a
 * trolley and that trolley has not been handed over. It fails CLOSED — a trolley named but unreadable, or in a state nobody
 * knows, is an open one — the way `cancelVerdict` refuses UNKNOWN_BATCH.
 *
 * And the client-safe gate the raise dialog reads (`carryOut` / `refusalFor`) gives the same answer, for all three asks.
 * ═══════════════════════════════════════════════════════════════════════
 */

describe('onOpenTrolley — the one predicate', () => {
  it('is true for an order on a READY trolley', () => {
    expect(onOpenTrolley({ shippingBatchId: 'b1', batchStatus: 'READY' })).toBe(true);
  });

  it.each(SEALED_BATCH_STATUSES)('is false once the trolley is %s — after the handover nothing changes (a cancel there is a request to the courier)', (status) => {
    expect(onOpenTrolley({ shippingBatchId: 'b1', batchStatus: status })).toBe(false);
  });

  it('is false for an order on no trolley, whatever a stray status says', () => {
    expect(onOpenTrolley({ shippingBatchId: null, batchStatus: null })).toBe(false);
    expect(onOpenTrolley({ shippingBatchId: undefined, batchStatus: undefined })).toBe(false);
    expect(onOpenTrolley({ shippingBatchId: null, batchStatus: 'READY' })).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['a word nobody knows', 'LOADING'],
    ['lower case', 'shipped'],
  ])('FAILS CLOSED: a trolley named whose status is %s counts as open', (_name, status) => {
    expect(onOpenTrolley({ shippingBatchId: 'b1', batchStatus: status as string | null | undefined })).toBe(true);
  });

  it('says one sentence, under one code', () => {
    expect(ON_OPEN_TROLLEY).toBe('ON_OPEN_TROLLEY');
    expect(ON_TROLLEY_AR).toContain('دفعة شحن جاهزة');
    expect(ON_TROLLEY_AR).toContain('أجّل الشحن');
  });
});

describe('the gate the dialog reads — the same answer as the door', () => {
  it.each(CHANGE_INTENTS)('%s on an open trolley is REFUSED with the sentence and the code', (intent) => {
    const out = carryOut(intent, { handedToCourier: false, onOpenTrolley: true });
    expect(out).toEqual({ kind: 'REFUSED', reason: ON_TROLLEY_AR, code: ON_OPEN_TROLLEY });
    expect(refusalFor(intent, { handedToCourier: false, onOpenTrolley: true })).toBe(ON_TROLLEY_AR);
  });

  it('NEGATIVE: off the trolley each ask is carried out by its own door, as before', () => {
    const ours = { handedToCourier: false, onOpenTrolley: false };
    expect(carryOut('EDIT', ours)).toEqual({ kind: 'EDIT_ORDER' });
    expect(carryOut('CANCEL', ours)).toEqual({ kind: 'CANCEL_ORDER' });
    expect(carryOut('POSTPONE', ours)).toEqual({ kind: 'HOLD_SHIPMENT' });
  });

  it('NEGATIVE: after the handover the courier answers stand, the trolley is not asked', () => {
    const gone = { handedToCourier: true, onOpenTrolley: false };
    expect(carryOut('CANCEL', gone)).toEqual({ kind: 'CANCEL_VIA_COURIER' });
    expect(carryOut('POSTPONE', gone).kind).toBe('REFUSED');
    expect(carryOut('POSTPONE', gone)).not.toHaveProperty('code');
  });

  it('NEGATIVE: a caller that does not say (no `onOpenTrolley`) keeps the answer it always had', () => {
    expect(carryOut('CANCEL', { handedToCourier: false })).toEqual({ kind: 'CANCEL_ORDER' });
  });
});
