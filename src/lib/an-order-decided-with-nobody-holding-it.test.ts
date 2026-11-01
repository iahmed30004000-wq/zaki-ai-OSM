import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { orderStages, type StageSource } from './order-stages';
import { agentMustPullFirst, OPEN_CONFIRMATION } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN ORDER DECIDED WITH NOBODY HOLDING IT — WHAT THE SCREEN SAYS (the owner, 1/11)
 *
 * ORD-2026-1896: one agent pressed «تأكيد» from the orders list on an order nobody had pulled. The data was right (confirmed at 18:16,
 * in the warehouse stage, a call logged first) and the screen lied twice: the path read «التأكيد: لم يمر بها» in the very card that said
 * «محاولات التواصل: 1 · أُكِّد: نعم», because the confirmation stage began at `claimedAt` alone; and the box read «متاح في الطابور».
 *
 *  · a confirmation given with no claim is a stage that HAPPENED: reached at the yes, by whoever gave it, with its facts, and said to
 *    have had no holder — no duration is invented for it;
 *  · an order that truly never passed confirmation (imported straight to the warehouse: no claim AND no yes) still reads «لم يمر بها»;
 *  · an order claimed and confirmed reads exactly as before;
 *  · the sheet's «pull it first» sentence is owed to an AGENT on an order still waiting, and to nobody else.
 * ═══════════════════════════════════════════════════════════════════════
 */

const base = (over: Partial<StageSource> = {}): StageSource => ({
  createdAt: new Date('2026-11-01T18:14:00Z'),
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY',
  ...over,
});
const byKey = (stages: ReturnType<typeof orderStages>) => Object.fromEntries(stages.map((s) => [s.key, s]));
const NOW = new Date('2026-11-01T18:47:00Z');

describe('confirmed, with no claim — ORD-2026-1896', () => {
  const stages = () =>
    byKey(
      orderStages(
        base({
          claimedAt: null,
          confirmedAt: new Date('2026-11-01T18:16:00Z'),
          confirmer: { name: 'عبير' },
          moderator: { name: 'sara' },
          source: 'فارما كبر 2',
        }),
        { contactAttempts: 1 },
        NOW
      )
    );

  it('the confirmation stage HAPPENED: done, at the moment of the yes — not «لم يمر بها»', () => {
    const s = stages();
    expect(s.CONFIRMATION.status).toBe('DONE');
    expect(s.CONFIRMATION.at?.toISOString()).toBe('2026-11-01T18:16:00.000Z');
  });

  it('says who gave the yes, how many calls there were, and that nobody held the order', () => {
    const s = stages();
    expect(s.CONFIRMATION.who).toBe('عبير');
    expect(s.CONFIRMATION.facts).toContainEqual({ label: 'محاولات التواصل', value: '1' });
    expect(s.CONFIRMATION.facts).toContainEqual({ label: 'أُكّد', value: 'نعم' });
    expect(s.CONFIRMATION.facts).toContainEqual({ label: 'الاستلام', value: 'بلا استلام' });
  });

  it('invents no duration for it: the stage began and ended at the yes, and nobody measured time in it', () => {
    expect(stages().CONFIRMATION.minutes).toBeNull();
    expect(stages().CONFIRMATION.ongoing).toBe(false);
  });

  it('the order is where it is: the warehouse is current, with the time since the yes (31 minutes)', () => {
    const s = stages();
    expect(s.WAREHOUSE.status).toBe('CURRENT');
    expect(s.WAREHOUSE.minutes).toBe(31);
    expect(s.INTAKE.minutes).toBe(2); // 18:14 → 18:16, as the card said «استغرقت 2 دقيقة»
  });
});

describe('what did not change', () => {
  it('an order that was claimed and confirmed: the claim starts the stage, the claimer is who, and no «بلا استلام»', () => {
    const s = byKey(
      orderStages(
        base({
          claimedAt: new Date('2026-11-01T18:15:00Z'),
          confirmedAt: new Date('2026-11-01T18:20:00Z'),
          claimer: { name: 'ليلى' },
          confirmer: { name: 'ليلى' },
        }),
        { contactAttempts: 2 },
        NOW
      )
    );
    expect(s.CONFIRMATION.at?.toISOString()).toBe('2026-11-01T18:15:00.000Z');
    expect(s.CONFIRMATION.who).toBe('ليلى');
    expect(s.CONFIRMATION.minutes).toBe(5);
    expect(s.CONFIRMATION.facts.find((f) => f.label === 'الاستلام')).toBeUndefined();
  });

  it('NEGATIVE: an order that never passed confirmation at all (no claim AND no yes) still reads «لم يمر بها»', () => {
    const s = byKey(
      orderStages(
        base({ claimedAt: null, confirmedAt: null, shippingStatus: 'SHIPPED', shippedAt: new Date('2026-11-02T10:00:00Z') }),
        {},
        NOW
      )
    );
    expect(s.CONFIRMATION.status).toBe('SKIPPED');
    expect(s.CONFIRMATION.at).toBeNull();
    expect(s.CONFIRMATION.who).toBeNull();
  });

  it('NEGATIVE: an order still waiting is not «reached» by the fallback — it has no yes to stand on', () => {
    const s = byKey(orderStages(base({ confirmationStatus: 'NEW', claimedAt: null, confirmedAt: null }), {}, NOW));
    expect(s.CONFIRMATION.status).toBe('PENDING');
  });
});

describe('the sheet owes «اسحبه أولاً» to an agent on an order still waiting — and to nobody else', () => {
  const holds = (...keys: string[]) => (p: string) => keys.includes(p);
  const AGENT = holds('confirmation.work', 'orders.confirm');
  const waiting = { claimedById: null, confirmationStatus: 'NEW' };

  it('an agent, an unheld order that is still open ⇒ yes', () => {
    expect(agentMustPullFirst({ holds: AGENT, userId: 'a1', order: waiting })).toBe(true);
    for (const confirmationStatus of OPEN_CONFIRMATION) {
      expect(agentMustPullFirst({ holds: AGENT, userId: 'a1', order: { claimedById: 'a2', confirmationStatus } }), confirmationStatus).toBe(true);
    }
  });

  it('the order is hers ⇒ no', () => {
    expect(agentMustPullFirst({ holds: AGENT, userId: 'a1', order: { claimedById: 'a1', confirmationStatus: 'IN_PROGRESS' } })).toBe(false);
  });

  it('the order is already decided ⇒ no: there is nothing left to pull it for', () => {
    for (const confirmationStatus of ['CONFIRMED', 'REJECTED', 'CANCELLED']) {
      expect(agentMustPullFirst({ holds: AGENT, userId: 'a1', order: { claimedById: null, confirmationStatus } }), confirmationStatus).toBe(false);
    }
  });

  it('the LIVE agent role, `confirmation.supervise` and `confirmation.reassign` included ⇒ yes (they excuse nobody)', () => {
    const live = holds('confirmation.work', 'confirmation.supervise', 'confirmation.reassign', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view');
    expect(agentMustPullFirst({ holds: live, userId: 'a1', order: waiting })).toBe(true);
  });

  it('a manager who can take or hand out any order, the owner, and somebody who is not an agent of the queue ⇒ no', () => {
    expect(agentMustPullFirst({ holds: holds('confirmation.work', 'orders.unlock'), userId: 'a1', order: waiting })).toBe(false);
    expect(agentMustPullFirst({ holds: holds('confirmation.work', 'orders.assign'), userId: 'a1', order: waiting })).toBe(false);
    expect(agentMustPullFirst({ holds: () => true, userId: 'owner', order: waiting })).toBe(false);
    expect(agentMustPullFirst({ holds: holds('orders.confirm'), userId: 'a1', order: waiting })).toBe(false);
  });

  it('a session with no id yet is not treated as holding anything', () => {
    expect(agentMustPullFirst({ holds: AGENT, userId: undefined, order: waiting })).toBe(true);
  });
});
