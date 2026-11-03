import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { EDIT_CONFIRMED_KEY } from './edit-confirmed-key';
import { EDIT_WINDOW_NOTE_AR, EDIT_WINDOW_OWNER_NOTE_AR, editWindowOpen, editsNow, type EditWindowFacts, type WindowOrder } from './edit-confirmed-window';

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
  it('is orders.edit_confirmed — a box the owner ticks; who holds it is the-edit-confirmed-key-goes-to-its-holders-only.test.ts', () => {
    expect(EDIT_CONFIRMED_KEY).toBe('orders.edit_confirmed');
  });

  it('the decision note names who did what, in plain Arabic and with no Latin word', () => {
    expect(EDIT_WINDOW_NOTE_AR).toBe('طُبِّق مباشرةً — رافعه يملك «تعديل الطلب المؤكَّد قبل الدفعة» والطلب لم يدخل دفعة شحن بعد.');
    expect(EDIT_WINDOW_NOTE_AR).not.toMatch(/[A-Za-z]/);
  });

  it('the owner’s note says it was the owner, and before the batch — plain Arabic, its own sentence', () => {
    expect(EDIT_WINDOW_OWNER_NOTE_AR).toBe('طُبِّق مباشرةً — المالك، والطلب لم يدخل دفعة شحن بعد.');
    expect(EDIT_WINDOW_OWNER_NOTE_AR).not.toMatch(/[A-Za-z]/);
    expect(EDIT_WINDOW_OWNER_NOTE_AR).not.toBe(EDIT_WINDOW_NOTE_AR);
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

  it('THE OWNER (3/11): full access opens it on an order he does not hold — or that nobody holds', () => {
    const owner: EditWindowFacts = { ...OPEN, userId: 'owner', fullAccess: true };
    expect(editWindowOpen(owner)).toBe(true);
    expect(editWindowOpen({ ...owner, claimedById: null })).toBe(true);
    expect(editWindowOpen({ ...owner, claimedById: undefined })).toBe(true);
    // Absent or false is «no»: a colleague's order stays shut for everybody else.
    expect(editWindowOpen({ ...owner, fullAccess: false })).toBe(false);
    expect(editWindowOpen({ ...owner, fullAccess: undefined })).toBe(false);
  });

  it('NEGATIVE: the owner’s window has the SAME limits — confirmed, no batch, not with the courier, and the safe defaults', () => {
    const owner: EditWindowFacts = { ...OPEN, userId: 'owner', claimedById: 'salma', fullAccess: true };
    for (const confirmationStatus of ['IN_PROGRESS', 'POSTPONED', 'REJECTED', 'CANCELLED']) {
      expect(editWindowOpen({ ...owner, confirmationStatus }), confirmationStatus).toBe(false);
    }
    expect(editWindowOpen({ ...owner, inBatch: true })).toBe(false);
    expect(editWindowOpen({ ...owner, handedToCourier: true })).toBe(false);
    expect(editWindowOpen({ ...owner, inBatch: undefined })).toBe(false);
    expect(editWindowOpen({ ...owner, handedToCourier: undefined })).toBe(false);
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

  it('THE OWNER (SUPER_ADMIN, 3/11) — «انتا ادخل وعدل»: every ask applies at once on any confirmed order before the batch, held or not', () => {
    const owner = person({ id: 'owner', role: 'SUPER_ADMIN', permissions: [] });
    for (const intent of ['EDIT', 'CANCEL', 'POSTPONE'] as const) {
      expect(editsNow(owner, hers({ claimedById: null }), intent), intent).toBe(true);
      expect(editsNow(owner, hers({ claimedById: 'salma' }), intent), intent).toBe(true);
      expect(editsNow(owner, hers({ claimedById: 'owner' }), intent), intent).toBe(true);
    }
  });

  it('NEGATIVE: the owner after the batch, or with the courier ⇒ the screen says «طلب», as for the agent', () => {
    const owner = person({ id: 'owner', role: 'SUPER_ADMIN', permissions: [] });
    for (const intent of ['EDIT', 'CANCEL', 'POSTPONE'] as const) {
      expect(editsNow(owner, hers({ claimedById: 'salma', shippingBatchId: 'b1', shippingBatch: { status: 'READY' } }), intent)).toBe(false);
      expect(editsNow(owner, hers({ claimedById: 'salma', shippingBatchId: null, shippingBatch: { status: 'READY' } }), intent)).toBe(false);
      expect(editsNow(owner, hers({ claimedById: 'salma', shippingStatus: 'SHIPPED' }), intent)).toBe(false);
      expect(editsNow(owner, hers({ claimedById: 'salma', confirmationStatus: 'IN_PROGRESS' }), intent)).toBe(false);
    }
  });

  it('NEGATIVE: the owner on a PRINTED WAYBILL ⇒ an edit is a request (the seal), a cancel or a hold applies at once', () => {
    const owner = person({ id: 'owner', role: 'SUPER_ADMIN', permissions: [] });
    const labelled = hers({ claimedById: 'salma', labelPrintedAt: new Date('2026-11-01T08:00:00Z') });
    expect(editsNow(owner, labelled, 'EDIT')).toBe(false);
    expect(editsNow(owner, labelled, 'CANCEL')).toBe(true);
    expect(editsNow(owner, labelled, 'POSTPONE')).toBe(true);
  });

  it.each(['MANAGER', 'COMPANY_ADMIN', 'CONFIRMATION_SUPERVISOR', 'DELIVERY_MANAGER', 'MODERATOR'])(
    'NEGATIVE: %s with EVERY key but not full access, on an order he does not hold ⇒ never — the owner’s window is not a key',
    (role) => {
      const allKeys = person({ id: 'boss', role: role as SessionUser['role'], permissions: [EDIT_CONFIRMED_KEY, 'orders.request_change', 'control.change_requests', 'orders.change_price', 'ops.decide_changes', 'ops.ship', 'orders.unlock'] });
      for (const intent of ['EDIT', 'CANCEL', 'POSTPONE'] as const) {
        expect(editsNow(allKeys, hers({ claimedById: 'salma' }), intent)).toBe(false);
        expect(editsNow(allKeys, hers({ claimedById: null }), intent)).toBe(false);
      }
    }
  );

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
