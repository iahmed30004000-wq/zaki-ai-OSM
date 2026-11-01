import { describe, expect, it } from 'vitest';
import {
  RESERVATION_HOURS,
  agentForReturningCustomer,
  handlerOf,
  heldFor,
  isReservedNow,
  reservationCutoff,
  reservationEnds,
  reservationHoursLeft,
  reservedForOthersWhere,
  reservedForWhere,
  reservedMessage,
  reservedWhere,
} from './order-reservation';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * The owner, 31/10: a returning customer's new order goes to the agent who dealt with him — seen in the queue and in everybody's
 * «الطلبات» with her name, taken by her alone; and it is everybody's when her account is not ACTIVE, or after 24 hours.
 *
 *  1. «Held» is one definition (`isReservedNow` and the filters `reservedWhere` / `reservedForWhere` / `reservedForOthersWhere`
 *     say the same thing — checked here row by row against a small evaluator of the filters).
 *  2. It stops holding at 24 hours exactly, when the assignee's account is not ACTIVE, when anybody holds the order, when it
 *     is no longer the order that just arrived, and when nothing says when it was held.
 *  3. The agent is the one who worked the NEWEST prior order — and only her: if she is unavailable the answer is nobody (no
 *     fallback to an older agent); a prior order nobody worked is skipped.
 *
 * Blockers: no money, no order creation (this file touches neither), no new column.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-10-31T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Evaluates exactly the operators the filters use — enough to ask the DATABASE's question of a plain row. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    if (key === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w as Record<string, unknown>));
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (cond instanceof Date || typeof cond !== 'object') {
      return cond instanceof Date ? value instanceof Date && value.getTime() === cond.getTime() : value === cond;
    }
    const ops = cond as Record<string, unknown>;
    return Object.entries(ops).every(([op, arg]) => {
      switch (op) {
        case 'not': return arg === null ? value !== null : value !== null && value !== arg;
        case 'gt': return value instanceof Date && value.getTime() > (arg as Date).getTime();
        case 'is': return value !== null && matches(value as Record<string, unknown>, arg as Record<string, unknown>);
        default: throw new Error(`the evaluator does not know «${op}»`);
      }
    });
  });
}

const row = (over: Record<string, unknown> = {}) => ({
  claimedById: null,
  confirmationStatus: 'NEW',
  assignedToId: 'sara',
  assignedAt: hoursAgo(1),
  assignee: { status: 'ACTIVE' },
  ...over,
});
const asRow = (r: ReturnType<typeof row>) => ({ ...r, assigneeStatus: r.assignee?.status ?? null });

describe('a held order, asked three ways, is one answer', () => {
  const cases: [string, ReturnType<typeof row>, boolean][] = [
    ['an order that has just arrived and was named for her an hour ago', row(), true],
    ['23 hours 59 minutes after it was held', row({ assignedAt: new Date(NOW.getTime() - (24 * 60 - 1) * 60_000) }), true],
    ['exactly 24 hours after (it has let go)', row({ assignedAt: hoursAgo(24) }), false],
    ['25 hours after', row({ assignedAt: hoursAgo(25) }), false],
    ['her account is suspended', row({ assignee: { status: 'SUSPENDED' } }), false],
    ['her account is disabled', row({ assignee: { status: 'DISABLED' } }), false],
    ['her account is still pending', row({ assignee: { status: 'PENDING' } }), false],
    ['somebody holds it', row({ claimedById: 'huda' }), false],
    ['it came back to the queue after a release (not the order that just arrived)', row({ confirmationStatus: 'IN_PROGRESS' }), false],
    ['nobody was named', row({ assignedToId: null, assignee: null }), false],
    ['a name but no time (a release clears it)', row({ assignedAt: null }), false],
  ];

  it.each(cases)('%s → held: %s', (_label, r, held) => {
    expect(isReservedNow(asRow(r), NOW)).toBe(held);
    expect(matches(r, reservedWhere(NOW))).toBe(held);
  });

  it('for HER: the same rows, and only when the name is hers', () => {
    expect(matches(row(), reservedForWhere('sara', NOW))).toBe(true);
    expect(matches(row(), reservedForWhere('huda', NOW))).toBe(false);
    expect(matches(row({ assignedAt: hoursAgo(30) }), reservedForWhere('sara', NOW))).toBe(false);
  });

  it('for OTHERS: held for somebody who is not me — and never an order held for me, nor one held for nobody', () => {
    expect(matches(row(), reservedForOthersWhere('huda', NOW))).toBe(true);
    expect(matches(row(), reservedForOthersWhere('sara', NOW))).toBe(false);
    expect(matches(row({ assignedToId: null, assignee: null }), reservedForOthersWhere('huda', NOW))).toBe(false);
    expect(matches(row({ assignee: { status: 'DISABLED' } }), reservedForOthersWhere('huda', NOW))).toBe(false);
    expect(matches(row({ assignedAt: hoursAgo(25) }), reservedForOthersWhere('huda', NOW))).toBe(false);
  });
});

describe('the twenty-four hours', () => {
  it('count down in whole hours, never below one', () => {
    expect(reservationHoursLeft(hoursAgo(5), NOW)).toBe(19);
    expect(reservationHoursLeft(new Date(NOW.getTime() - (24 * 60 - 5) * 60_000), NOW)).toBe(1);
  });

  it('are the owner’s: «24 ساعة فقط وبعدها عام»', () => {
    expect(RESERVATION_HOURS).toBe(24);
    expect(reservationCutoff(NOW).getTime()).toBe(NOW.getTime() - 24 * 3_600_000);
    expect(reservationEnds(hoursAgo(5)).getTime()).toBe(NOW.getTime() + 19 * 3_600_000);
  });

});

describe('who a returning customer goes back to', () => {
  const eligible = new Set(['sara', 'huda']);

  it('is the agent who worked the newest prior order that anybody worked', () => {
    expect(agentForReturningCustomer([{ claimedById: 'sara' }, { claimedById: 'huda' }], eligible)).toBe('sara');
  });

  it('skips a prior order nobody worked, and takes the next one', () => {
    expect(agentForReturningCustomer([{}, { claimedById: null, currentOwnerId: null }, { claimedById: 'huda' }], eligible)).toBe('huda');
  });

  it('reads the holder first, then the last owner, then who confirmed it', () => {
    expect(handlerOf({ claimedById: 'a', currentOwnerId: 'b', confirmedById: 'c' })).toBe('a');
    expect(handlerOf({ claimedById: null, currentOwnerId: 'b', confirmedById: 'c' })).toBe('b');
    expect(handlerOf({ confirmedById: 'c' })).toBe('c');
    expect(handlerOf({})).toBeNull();
  });

  it('is NOBODY when she is not available — it does not fall back to the agent before her', () => {
    expect(agentForReturningCustomer([{ claimedById: 'disabled-one' }, { claimedById: 'huda' }], eligible)).toBeNull();
  });

  it('is nobody for a customer whose earlier orders nobody worked, or who has none', () => {
    expect(agentForReturningCustomer([{}, {}], eligible)).toBeNull();
    expect(agentForReturningCustomer([], eligible)).toBeNull();
  });
});

describe('the sentence', () => {
  it('names her, says she is the one who dealt with him, and when it opens', () => {
    const said = reservedMessage('سارة');
    expect(said).toContain('تابع لـسارة');
    expect(said).toContain('تعاملت مع هالزبون');
    expect(said).toContain('24 ساعة');
  });

  it('has a name for the one it cannot name', () => {
    expect(reservedMessage(null)).toContain('زميلتك');
  });
});

describe('whom it is held for, as a screen reads it', () => {
  const held = { claimedById: null, confirmationStatus: 'NEW', assignedToId: 'sara', assignedAt: hoursAgo(2), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' } };

  it('is the agent’s id and name while the hold stands', () => {
    expect(heldFor(held, NOW)).toEqual({ id: 'sara', name: 'سارة' });
  });

  it.each([
    ['a day gone', { assignedAt: hoursAgo(24) }],
    ['her account off', { assignee: { id: 'sara', name: 'سارة', status: 'DISABLED' } }],
    ['somebody holds it', { claimedById: 'huda' }],
    ['no agent on the row', { assignee: null }],
    ['an agent whose status the read did not carry', { assignee: { id: 'sara', name: 'سارة' } }],
  ])('is nothing when %s — so no screen draws a mark that is not true', (_label, patch) => {
    expect(heldFor({ ...held, ...patch }, NOW)).toBeNull();
  });
});
