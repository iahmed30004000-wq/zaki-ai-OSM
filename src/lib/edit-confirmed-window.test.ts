import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { EDIT_CONFIRMED_KEY, EDIT_CONFIRMED_NEEDS } from './edit-confirmed-key';
import { EDIT_WINDOW_NOTE_AR, editWindowOpen, editsNow, type EditWindowFacts, type WindowOrder } from './edit-confirmed-window';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HOLDER'S OWN WINDOW — THE PREDICATE, WRITTEN ONCE (the owner, 2/11).
 *
 * «أضيفهم كصلاحية انو يقدرو يعدلو ع الطلب لغاية مرحلة الشحنة. مجرد ما الشحنة اتوزعت ع شركة شحن ودخلت باتش ما بقدرو يعدلو».
 *
 * The server (`mayDecide`) and the screens (`editsNow`) read the same function, so this file holds it by itself: every
 * condition has the row that breaks it, and the two safe defaults (an unsaid batch is «in a batch», an unsaid handover is
 * «taken») have their rows too. The server's own table, through the real permission engine, is
 * `the-holder-decides-her-own-confirmed-order.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const OPEN: EditWindowFacts = {
  userId: 'salma',
  confirmationStatus: 'CONFIRMED',
  claimedById: 'salma',
  inBatch: false,
  handedToCourier: false,
};

describe('the key', () => {
  it('is orders.edit_confirmed, and a role receives it holding BOTH confirmation.work and orders.request_change', () => {
    expect(EDIT_CONFIRMED_KEY).toBe('orders.edit_confirmed');
    expect([...EDIT_CONFIRMED_NEEDS]).toEqual(['confirmation.work', 'orders.request_change']);
  });

  it('the decision note names who did what, in plain Arabic and with no Latin word', () => {
    expect(EDIT_WINDOW_NOTE_AR).toBe('طُبِّق مباشرةً — رافعه يملك «تعديل الطلب المؤكَّد قبل الدفعة» والطلب لم يدخل دفعة شحن بعد.');
    expect(EDIT_WINDOW_NOTE_AR).not.toMatch(/[A-Za-z]/);
  });
});

describe('editWindowOpen — open only when ALL FIVE hold', () => {
  it('confirmed, hers, in no batch, not with the courier ⇒ open', () => {
    expect(editWindowOpen(OPEN)).toBe(true);
  });

  it.each(['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED', 'REJECTED', 'CANCELLED'])(
    'NEGATIVE: an order that is %s is not a confirmed one ⇒ shut',
    (confirmationStatus) => {
      expect(editWindowOpen({ ...OPEN, confirmationStatus })).toBe(false);
    }
  );

  it('NEGATIVE: a colleague holds it, or nobody does ⇒ shut — the window is HERS', () => {
    expect(editWindowOpen({ ...OPEN, claimedById: 'someone-else' })).toBe(false);
    expect(editWindowOpen({ ...OPEN, claimedById: null })).toBe(false);
    expect(editWindowOpen({ ...OPEN, claimedById: undefined })).toBe(false);
    // Nor does an empty id on both sides count as «hers».
    expect(editWindowOpen({ ...OPEN, userId: '', claimedById: '' })).toBe(false);
  });

  it('NEGATIVE: it entered a batch ⇒ shut, even though the courier does not have it yet', () => {
    expect(editWindowOpen({ ...OPEN, inBatch: true, handedToCourier: false })).toBe(false);
  });

  it('NEGATIVE: the courier has it ⇒ shut, even with no batch (a parcel marked shipped by hand sits in none)', () => {
    expect(editWindowOpen({ ...OPEN, inBatch: false, handedToCourier: true })).toBe(false);
  });

  it('SAFE DEFAULTS: a caller that does not say reads as «in a batch» and «taken» ⇒ shut', () => {
    expect(editWindowOpen({ ...OPEN, inBatch: undefined })).toBe(false);
    expect(editWindowOpen({ ...OPEN, handedToCourier: undefined })).toBe(false);
    const { inBatch: _a, handedToCourier: _b, ...silent } = OPEN;
    void _a;
    void _b;
    expect(editWindowOpen(silent)).toBe(false);
  });
});

const person = (over: Partial<SessionUser> = {}): SessionUser =>
  ({ id: 'salma', name: 'سلمى', email: 's@x', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: 'c1', permissions: [EDIT_CONFIRMED_KEY, 'orders.request_change'], ...over }) as SessionUser;

/** A confirmed order she holds, on no trolley, with the read a screen has (the same fields `GET /api/orders/[id]` returns). */
const hers = (over: Partial<WindowOrder> = {}): WindowOrder => ({
  confirmationStatus: 'CONFIRMED',
  claimedById: 'salma',
  shippingBatchId: null,
  shippingBatch: null,
  shippingStatus: 'NOT_READY',
  shippedAt: null,
  labelPrintedAt: null,
  ...over,
});

describe('editsNow — the screen asks the same question, per ask', () => {
  it.each(['EDIT', 'CANCEL', 'POSTPONE'] as const)('her own confirmed order in no batch ⇒ %s is applied at once', (intent) => {
    expect(editsNow(person(), hers(), intent)).toBe(true);
  });

  it('defaults to an edit', () => {
    expect(editsNow(person(), hers())).toBe(true);
    expect(editsNow(person(), hers({ labelPrintedAt: new Date() }))).toBe(false);
  });

  it('NEGATIVE: without the key, whoever she is ⇒ never', () => {
    const noKey = person({ permissions: ['orders.request_change', 'confirmation.work'] });
    for (const intent of ['EDIT', 'CANCEL', 'POSTPONE'] as const) expect(editsNow(noKey, hers(), intent)).toBe(false);
    expect(editsNow(null, hers())).toBe(false);
    expect(editsNow(undefined, hers())).toBe(false);
  });

  it('NEGATIVE: not hers, not confirmed, not holding ⇒ never', () => {
    expect(editsNow(person(), hers({ claimedById: 'someone-else' }))).toBe(false);
    expect(editsNow(person(), hers({ claimedById: null }))).toBe(false);
    expect(editsNow(person(), hers({ confirmationStatus: 'IN_PROGRESS' }))).toBe(false);
  });

  it('NEGATIVE: the owner holds every key, and still holds no order he did not pull — the window is a holder’s', () => {
    const owner = person({ id: 'owner', role: 'SUPER_ADMIN', permissions: [] });
    expect(editsNow(owner, hers({ claimedById: null }))).toBe(false);
    expect(editsNow(owner, hers({ claimedById: 'salma' }))).toBe(false);
    expect(editsNow(owner, hers({ claimedById: 'owner' }))).toBe(true);
  });

  it('NEGATIVE: in a batch, by the column or by the relation ⇒ never; by neither it opens', () => {
    for (const intent of ['EDIT', 'CANCEL', 'POSTPONE'] as const) {
      expect(editsNow(person(), hers({ shippingBatchId: 'b1', shippingBatch: null }), intent)).toBe(false);
      expect(editsNow(person(), hers({ shippingBatchId: null, shippingBatch: { status: 'READY' } }), intent)).toBe(false);
      expect(editsNow(person(), hers({ shippingBatchId: 'b1', shippingBatch: { status: 'SHIPPED' } }), intent)).toBe(false);
    }
  });

  it('SAFE DEFAULT: a read that carries neither batch field, or no shipping status, says nothing ⇒ shut', () => {
    const { shippingBatchId: _a, shippingBatch: _b, ...noBatchFields } = hers();
    void _a;
    void _b;
    expect(editsNow(person(), noBatchFields, 'CANCEL')).toBe(false);
    const { shippingStatus: _c, ...noStatus } = hers();
    void _c;
    expect(editsNow(person(), noStatus, 'CANCEL')).toBe(false);
    expect(editsNow(person(), hers({ shippingStatus: null }), 'CANCEL')).toBe(false);
    // …and a row that carries ONLY the column (the desk's «أكّدتها» rows) is enough to say «no batch».
    const { shippingBatch: _d, ...onlyTheColumn } = hers();
    void _d;
    expect(editsNow(person(), onlyTheColumn, 'CANCEL')).toBe(true);
  });

  it('NEGATIVE: the courier has it — shippedAt, or a status that left — ⇒ never, though no trolley is named', () => {
    for (const intent of ['EDIT', 'CANCEL', 'POSTPONE'] as const) {
      expect(editsNow(person(), hers({ shippedAt: new Date() }), intent)).toBe(false);
      expect(editsNow(person(), hers({ shippingStatus: 'SHIPPED' }), intent)).toBe(false);
      expect(editsNow(person(), hers({ shippingStatus: 'OUT_FOR_DELIVERY' }), intent)).toBe(false);
    }
  });

  it('THE SEAL IS ON TOP, FOR AN EDIT ONLY: a printed waybill stops an edit and not a cancel or a hold', () => {
    const labelled = hers({ labelPrintedAt: new Date('2026-11-01T08:00:00Z') });
    expect(editsNow(person(), labelled, 'EDIT')).toBe(false);
    expect(editsNow(person(), labelled, 'CANCEL')).toBe(true);
    expect(editsNow(person(), labelled, 'POSTPONE')).toBe(true);
  });
});
