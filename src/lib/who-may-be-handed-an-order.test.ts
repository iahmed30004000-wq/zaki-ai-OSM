import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { claimByNumberMessage, mayBeHandedAnOrder, NOT_HELD_MESSAGE } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «CAN WORK THE ORDER» IS THREE KEYS, AND NO ONE OF THEM IS ENOUGH (BACKLOG RV567)
 *
 * The transfer door handed an order to anybody holding `confirmation.work`. The supervisor template holds that key (she works a queue to
 * watch it) and nothing she needs to DO anything to an order: no `confirmation.pull`, no `orders.confirm` (the first thing the confirmation
 * door asks, of every action), no `orders.contact_log`. The truth table: the target works the order only with the desk, the pull and the
 * decision together. The route tests (`transfer/the-transfer-list-and-door-agree-on-who-can-work.test.ts`) run the same rule through the
 * real engine; this holds the rule itself, every combination, with nothing else in the way.
 * ═══════════════════════════════════════════════════════════════════════
 */

const KEYS = ['confirmation.work', 'confirmation.pull', 'orders.confirm'] as const;
const holding = (...keys: string[]) => (permission: string) => keys.includes(permission);

describe('mayBeHandedAnOrder', () => {
  const combos: string[][] = [];
  for (let mask = 0; mask < 8; mask++) combos.push(KEYS.filter((_k, i) => mask & (1 << i)));

  it.each(combos)('holding %j ⇒ only the full set may be handed an order', (...held) => {
    expect(mayBeHandedAnOrder(holding(...held))).toBe(held.length === 3);
  });

  it('covers all eight combinations, and exactly one of them is true', () => {
    expect(combos).toHaveLength(8);
    expect(combos.filter((c) => mayBeHandedAnOrder(holding(...c)))).toEqual([[...KEYS]]);
  });

  it('the supervisor template: the desk and the oversight, no pull, no decision ⇒ no', () => {
    expect(mayBeHandedAnOrder(holding('confirmation.work', 'confirmation.supervise', 'confirmation.issues', 'orders.view'))).toBe(false);
  });

  it('a follow-up agent: the desk and the pull, no decision ⇒ no', () => {
    expect(mayBeHandedAnOrder(holding('confirmation.work', 'confirmation.pull', 'orders.contact_log', 'orders.edit'))).toBe(false);
  });

  it('whoever holds every key (the owner) ⇒ yes', () => {
    expect(mayBeHandedAnOrder(() => true)).toBe(true);
  });

  it('nobody ⇒ no', () => {
    expect(mayBeHandedAnOrder(() => false)).toBe(false);
  });
});

describe('claimByNumberMessage — the pull is named only when she has it', () => {
  it('with `confirmation.pull`: points to «اسحب الطلب التالي»', () => {
    expect(claimByNumberMessage(holding('confirmation.pull'))).toContain('اسحب الطلب التالي');
  });

  it('without it: says so, and names no button she does not have', () => {
    const said = claimByNumberMessage(holding());
    expect(said).not.toContain('اسحب الطلب التالي');
    expect(said).toContain('صلاحية سحب الطلبات');
  });

  it('is not the sentence of the other doors (she holds nothing yet — «اسحب الطلب أولاً» would be a different lie)', () => {
    expect(claimByNumberMessage(holding('confirmation.pull'))).not.toBe(NOT_HELD_MESSAGE);
    expect(claimByNumberMessage(holding())).not.toBe(NOT_HELD_MESSAGE);
  });
});
