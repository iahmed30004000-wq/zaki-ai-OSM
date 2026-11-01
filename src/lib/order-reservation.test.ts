import { describe, expect, it } from 'vitest';
import {
  RESERVATION_HOURS,
  agentForReturningCustomer,
  handlerOf,
  heldFor,
  isReservedNow,
  notHeldForOthersWhere,
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
 *     say the same thing — checked here row by row against an evaluator of the filters that knows SQL's THREE values).
 *  2. It stops holding at 24 hours exactly, when the assignee's account is not ACTIVE, when anybody holds the order, when it
 *     is no longer the order that just arrived, when nothing says when it was held, and when anybody has EVER claimed it.
 *  3. `notHeldForOthersWhere` — what the pull, the counter and the claim gate use — is the exact complement of
 *     `reservedForOthersWhere` for every row, NULLs included. (The first version wrote the gate as `NOT (…)`: for a row whose
 *     `assignedAt` is NULL that is NULL, not TRUE, and the row vanished for everybody — the independent review found it, and the
 *     two-valued evaluator this file used to carry could not have.)
 *  4. The agent is the one who worked the NEWEST prior order — and only her: if she is unavailable the answer is nobody (no
 *     fallback to an older agent); a prior order nobody worked is skipped.
 *
 * Blockers: no money, no order creation (this file touches neither), no new column.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-10-31T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

type Row = Record<string, any>;
type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not = (x: Tri): Tri => (x === null ? null : !x);

/**
 * The database's question, asked of a plain row — with SQL's three values: a comparison with a NULL column is UNKNOWN, `NOT` of
 * unknown is unknown, and a WHERE keeps only TRUE. `IS NULL` / `IS NOT NULL` (`null` and `{ not: null }`) are the only
 * comparisons that never answer unknown.
 */
function tri(row: Row, where: Row): Tri {
  return and(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return and((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'OR') return or((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'NOT') return not(or((Array.isArray(cond) ? cond : [cond]).map((w) => tri(row, w as Row))));
      const value = row[key] ?? null;
      if (cond === null) return value === null;
      if (cond instanceof Date) return value === null ? null : value instanceof Date && value.getTime() === cond.getTime();
      if (typeof cond !== 'object') return value === null ? null : value === cond;
      return and(
        Object.entries(cond as Row).map(([op, arg]): Tri => {
          switch (op) {
            case 'not':
              if (arg === null) return value !== null;
              return value === null ? null : value !== arg;
            case 'gt': return value === null ? null : (value as Date).getTime() > (arg as Date).getTime();
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'is':
              if (arg === null) return value === null;
              return value === null ? null : tri(value as Row, arg as Row);
            case 'none': return !(row[key] ?? []).some((c: Row) => tri(c, arg as Row) === true);
            case 'some': return (row[key] ?? []).some((c: Row) => tri(c, arg as Row) === true);
            default: throw new Error(`the evaluator does not know «${op}»`);
          }
        })
      );
    })
  );
}
const matches = (row: Row, where: Row): boolean => tri(row, where) === true;

const row = (over: Row = {}): Row => ({
  claimedById: null,
  confirmationStatus: 'NEW',
  assignedToId: 'sara',
  assignedAt: hoursAgo(1),
  assignee: { status: 'ACTIVE' },
  claimHistory: [],
  ...over,
});
const asRow = (r: Row) => ({ ...r, assigneeStatus: r.assignee?.status ?? null, everClaimed: (r.claimHistory ?? []).length > 0 });

const CASES: [string, Row, boolean][] = [
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
  ['a name and a recent time, but somebody claimed it once and gave it back (the issues door leaves exactly this)', row({ claimHistory: [{ action: 'RELEASED' }] }), false],
  ['released with its name kept and its time cleared (the release door leaves exactly this)', row({ assignedAt: null, claimHistory: [{ action: 'RELEASED' }] }), false],
];

describe('a held order, asked three ways, is one answer', () => {
  it.each(CASES)('%s → held: %s', (_label, r, held) => {
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

describe('what a colleague may take is the exact complement of what is held for her — NULLs included', () => {
  const USERS = ['huda', 'sara', 'noor'];
  // Every row the cases name, plus the ones SQL's third value is made of: a name whose time, status or relation is missing.
  const ROWS: Row[] = [
    ...CASES.map(([, r]) => r),
    row({ assignedAt: null }),
    row({ assignedAt: null, assignee: null }),
    row({ assignee: null }),
    row({ assignedToId: null, assignedAt: hoursAgo(1), assignee: null }),
    row({ confirmationStatus: 'POSTPONED', assignedAt: null }),
    row({ claimedById: 'huda', assignedAt: null }),
  ];

  it.each(USERS)('for %s: takeable ⇔ NOT held-for-others, on every row', (user) => {
    for (const r of ROWS) {
      expect(matches(r, notHeldForOthersWhere(user, NOW)), JSON.stringify(r)).toBe(!matches(r, reservedForOthersWhere(user, NOW)));
    }
  });

  it('THE REGRESSION: an order released with its name kept and its time cleared is takeable by everybody', () => {
    const released = row({ assignedAt: null, claimHistory: [{ action: 'RELEASED' }] });
    for (const user of USERS) expect(matches(released, notHeldForOthersWhere(user, NOW)), user).toBe(true);
  });

  it('…and the first version, `NOT (held for others)`, is exactly what dropped it — so the gate is an OR on purpose', () => {
    // A row with a name, ACTIVE, NEW, unclaimed and NO TIME: the held-for-others conjunction is UNKNOWN, and NOT of unknown is
    // unknown, which a WHERE does not keep. (No claim history here, to isolate the NULL from the history rule.)
    const nameNoTime = row({ assignedAt: null });
    expect(matches(nameNoTime, { NOT: reservedForOthersWhere('huda', NOW) })).toBe(false);
    expect(matches(nameNoTime, notHeldForOthersWhere('huda', NOW))).toBe(true);
  });

  it('is takeable by the one it is held for, and by nobody else while it is held', () => {
    expect(matches(row(), notHeldForOthersWhere('sara', NOW))).toBe(true);
    expect(matches(row(), notHeldForOthersWhere('huda', NOW))).toBe(false);
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
    expect(said).toContain('24 ساعة من حجزه');
  });

  it('has a name for the one it cannot name', () => {
    expect(reservedMessage(null)).toContain('زميلتك');
  });
});

describe('whom it is held for, as a screen reads it', () => {
  const held = {
    claimedById: null, confirmationStatus: 'NEW', assignedToId: 'sara', assignedAt: hoursAgo(2), everClaimed: false,
    assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' },
  };

  it('is the agent’s id and name while the hold stands', () => {
    expect(heldFor(held, NOW)).toEqual({ id: 'sara', name: 'سارة' });
  });

  it.each([
    ['a day gone', { assignedAt: hoursAgo(24) }],
    ['her account off', { assignee: { id: 'sara', name: 'سارة', status: 'DISABLED' } }],
    ['somebody holds it', { claimedById: 'huda' }],
    ['no agent on the row', { assignee: null }],
    ['an agent whose status the read did not carry', { assignee: { id: 'sara', name: 'سارة' } }],
    ['somebody claimed it once and gave it back', { everClaimed: true }],
    ['the read did not say whether anybody ever claimed it', { everClaimed: undefined }],
  ])('is nothing when %s — so no screen draws a mark that is not true', (_label, patch) => {
    expect(heldFor({ ...held, ...patch }, NOW)).toBeNull();
  });
});
