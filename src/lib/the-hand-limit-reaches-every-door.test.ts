import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_CAPS,
  ENTRY_CAP_FULL_MESSAGE,
  RETURNS_MODE,
  capRefusal,
  capRoom,
  confirmNowReadiness,
  entryCapFullMessage,
  entryOwnership,
  pullPermission,
  pullRefusal,
  type OwnedCounts,
} from './confirmation-queue';
import { workFirstGate } from './work-first';
import { returnsMode } from './no-answer-returns';
import { workClock } from './no-answer-rounds';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HAND LIMIT IS A PARAMETER EVERY CAP QUESTION IS HANDED — NEVER A CHANGE TO THE 500 (the owner, 9/11)
 *
 * «الطلب يرجع للطابور فوراً» makes a hand five. The cap of 500 and the 40 untouched are asked by the pull, the claim-by-number door,
 * «الزبون على الخط», her own entries and the returning-customer hold; with the mode ON each is handed `RETURNS_MODE.handLimit`, and
 * with it OFF is handed nothing and asks 500 in the old words. This file holds the pure rules; the doors have their own tests
 * (`the-order-leaves-her-hand.test.ts`, `the-hand-limit-binds-taking-by-number.test.ts`,
 * `the-customer-on-the-line-finds-a-returned-order.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════
 */

const HAND = RETURNS_MODE.handLimit;
const counts = (total: number, heldForHer = 0, over: Partial<OwnedCounts> = {}): OwnedCounts => ({ total, heldForHer, withoutAttempt: 0, untouched: null, ...over });
const holds = (...keys: string[]) => (permission: string) => keys.includes(permission);

describe('the constants', () => {
  it('a hand is five, an idle order goes back after thirty working minutes; the cap and the untouched limit are not moved', () => {
    expect(HAND).toBe(5);
    expect(RETURNS_MODE.idleBusinessMinutes).toBe(30);
    expect(CLAIM_CAPS).toEqual({ withoutAttempt: 40, total: 500 });
  });
});

describe('capRoom — what she may still be named for', () => {
  it('under the limit: what is left of five, holds counted; at it, nothing; never negative', () => {
    expect(capRoom(counts(2), HAND)).toBe(3);
    expect(capRoom(counts(2, 2), HAND)).toBe(1);
    expect(capRoom(counts(3, 2), HAND)).toBe(0);
    expect(capRoom(counts(9, 4), HAND)).toBe(0);
  });

  it('with no limit it is the cap of 500, as ever', () => {
    expect(capRoom(counts(2))).toBe(498);
    expect(capRoom(counts(2, 2), undefined)).toBe(496);
  });
});

describe('capRefusal and pullRefusal — the same rule against five, in the owner’s sentence', () => {
  const SENTENCE = 'وصلت للحد (5) — خلّصي واحد أو اضغطي «أعِدْه إلى الطابور»';

  it('five in her hands: refused, whatever she takes — held for her or new', () => {
    for (const takesHeld of [true, false]) {
      expect(capRefusal(counts(5), takesHeld, HAND)).toEqual({ code: 'CAP_TOTAL', message: SENTENCE });
    }
  });

  it('four in her hands and one held for her: a NEW order is refused, what is held for her is hers to take', () => {
    expect(capRefusal(counts(4, 1), false, HAND)).toEqual({ code: 'CAP_TOTAL', message: SENTENCE });
    expect(capRefusal(counts(4, 1), true, HAND)).toBeNull();
  });

  it('under the limit: nothing is refused', () => {
    expect(capRefusal(counts(4), false, HAND)).toBeNull();
    expect(pullRefusal(counts(4), undefined, HAND)).toBeNull();
  });

  it('pullRefusal hands the limit to the cap — and the cap comes before the untouched order, as ever', () => {
    expect(pullRefusal(counts(5), undefined, HAND)).toEqual({ code: 'CAP_TOTAL', message: SENTENCE });
    const untouched = { id: 'o9', orderNumber: 'ORD-9' };
    expect(pullRefusal(counts(5, 0, { withoutAttempt: 1, untouched }), undefined, HAND)?.code).toBe('CAP_TOTAL');
    expect(pullRefusal(counts(2, 0, { withoutAttempt: 1, untouched }), undefined, HAND)).toMatchObject({ code: 'UNTOUCHED_ORDER', orderId: 'o9' });
  });

  it('pullPermission hands it on too — a supervisor is told she does not pull before she is told about a limit', () => {
    expect(pullPermission(true, counts(5), HAND)?.code).toBe('CAP_TOTAL');
    expect(pullPermission(true, counts(4), HAND)).toBeNull();
    expect(pullPermission(false, counts(5), HAND)?.code).toBe('NOT_YOUR_DESK');
  });

  it('OFF — handed nothing, five is nothing and the old words stand at 500', () => {
    expect(capRefusal(counts(5), false)).toBeNull();
    expect(pullRefusal(counts(5))).toBeNull();
    expect(pullPermission(true, counts(5))).toBeNull();
    expect(capRefusal(counts(500), false)?.message).toBe('بلغت الحد الأقصى (500 طلب لديك).');
    expect(capRefusal(counts(300, 200), false)?.message).toContain('المحجوز لك بينعدّ من الحد');
  });
});

describe('her own entry — the order she types is hers only while the hand has room', () => {
  const agent = holds('confirmation.work');
  const entry = (heldTotal: number, limit?: number) => entryOwnership({ userId: 'sara', holds: agent, heldTotal, now: new Date('2026-11-09T09:00:00Z'), limit });

  it('under five: hers; at five: to the queue, and the entry says so', () => {
    expect(entry(4, HAND)).toMatchObject({ claimedById: 'sara', capFull: false });
    expect(entry(5, HAND)).toMatchObject({ claimedById: null, claimedAt: null, currentOwnerId: null, capFull: true });
  });

  it('OFF — five is nothing; 500 is the end, as ever', () => {
    expect(entry(5)).toMatchObject({ claimedById: 'sara', capFull: false });
    expect(entry(499)).toMatchObject({ claimedById: 'sara' });
    expect(entry(500)).toMatchObject({ claimedById: null, capFull: true });
  });

  it('the sentence the form shows carries the limit; the old constant is the old sentence', () => {
    expect(entryCapFullMessage(HAND)).toBe('وصلت للحد (5) — الطلب راح للطابور');
    expect(ENTRY_CAP_FULL_MESSAGE).toBe('وصلت للحد (500) — الطلب راح للطابور');
    expect(entryCapFullMessage(CLAIM_CAPS.total)).toBe(ENTRY_CAP_FULL_MESSAGE);
  });

  it('«أكّده الآن» says CAP_FULL with the same number when the hand is full', () => {
    const full = entry(5, HAND);
    const args = { wanted: true, holds: holds('orders.confirm', 'orders.contact_log', 'confirmation.work'), userId: 'sara', entry: full, regionId: 'r1' };
    expect(confirmNowReadiness({ ...args, limit: HAND })).toEqual({ ready: false, code: 'CAP_FULL', reason: 'وصلت للحد (5) — الطلب راح للطابور' });
    expect(confirmNowReadiness(args)).toEqual({ ready: false, code: 'CAP_FULL', reason: ENTRY_CAP_FULL_MESSAGE });
  });
});

describe('«الشغل أول» goes quiet by construction — and only then', () => {
  const NOW = new Date('2026-11-09T09:30:00Z');
  const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
  const ON = { enabled: true, enabledAt: new Date('2026-11-01T05:00:00Z') };
  const gate = (extra: Record<string, unknown>, findMany = vi.fn(async () => [])) => ({
    run: () => workFirstGate({ order: { findMany } } as never, { scope: { companyId: 'c1', storeId: 's1' }, userId: 'sara', cal: JO, now: NOW, rounds: ON, open: ['IN_PROGRESS'], room: 500, held: 3, ...extra }),
    findMany,
  });

  it('with the mode handed to it the gate answers nothing and reads nothing', async () => {
    const g = gate({ returns: returnsMode(NOW, workClock(JO), RETURNS_MODE.idleBusinessMinutes) });
    expect(await g.run()).toBeNull();
    expect(g.findMany).not.toHaveBeenCalled();
  });

  it('without it (or null) the gate reads her held orders as it always did', async () => {
    for (const extra of [{}, { returns: null }, { returns: undefined }]) {
      const g = gate(extra);
      await g.run();
      expect(g.findMany).toHaveBeenCalledTimes(1);
    }
  });
});
