import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «باقي الموظفات يشوفوه ومايقدرو يسحبوه»
 *
 * An order held for a colleague (order-reservation.ts) is in EVERY confirmation agent's «الطلبات» with her name on it, and it
 * opens for them to read — but it is not a door to the pool: once it lets go (24 hours, her account off) it leaves the list
 * again, and an order a colleague merely HOLDS is still none of anybody's business.
 *
 * This is the envelope itself (`orderListWhere`, `orderVisibilityWhere`), evaluated against rows — the same shape of test
 * `entry-claim-reaches-both-doors.test.ts` holds the two envelopes to each other with.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('./authorization', () => ({
  can: () => true,
  requirePermission: vi.fn(),
  getPermissionScope: (u: SessionUser & { __scope?: string }) => (u.__scope ? { scope: u.__scope } : null),
}));

const { orderListWhere, orderVisibilityWhere } = await import('./rbac');

const agent = (scope: string, id = 'huda'): SessionUser => ({ id, status: 'ACTIVE', role: 'CUSTOM', __scope: scope }) as unknown as SessionUser;

type Row = Record<string, any>;
function matches(row: Row, where: Row): boolean {
  if (Object.keys(where).length === 0) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond !== 'object') return value === cond;
    return Object.entries(cond as Row).every(([op, arg]) => {
      switch (op) {
        case 'not': return arg === null ? value !== null : value !== null && value !== arg;
        case 'gt': return value instanceof Date && value.getTime() > (arg as Date).getTime();
        case 'lte': return value instanceof Date && value.getTime() <= (arg as Date).getTime();
        case 'is': return value !== null && matches(value as Row, arg as Row);
        default: throw new Error(`the evaluator does not know «${op}»`);
      }
    });
  });
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const base: Row = {
  claimedById: null, createdById: null, currentOwnerId: null, moderatorId: null, assignedToId: null, assignedAt: null,
  confirmationStatus: 'NEW', signatureStatus: 'UNSIGNED', lockedById: null, lockExpiresAt: null, assignee: null,
};
const heldFor = (id: string, ago: number, status = 'ACTIVE', over: Row = {}): Row => ({
  ...base, assignedToId: id, assignedAt: hoursAgo(ago), assignee: { status }, ...over,
});

describe('an agent’s «الطلبات»', () => {
  const list = () => orderListWhere(agent('ASSIGNED'));
  const read = () => orderVisibilityWhere(agent('ASSIGNED'));

  it('shows an order held for a colleague — and it opens', () => {
    const row = heldFor('sara', 1);
    expect(matches(row, list()), 'لا يظهر بقائمتها').toBe(true);
    expect(matches(row, read()), 'يظهر ولا يُفتَح').toBe(true);
  });

  it('shows the one held for HER, as it always did', () => {
    expect(matches(heldFor('huda', 1), list())).toBe(true);
  });

  it('stops showing it when the hold lets go: after a day, or when her account is off — the pool is still not her list', () => {
    expect(matches(heldFor('sara', 25), list())).toBe(false);
    expect(matches(heldFor('sara', 1, 'DISABLED'), list())).toBe(false);
    expect(matches(heldFor('sara', 1, 'SUSPENDED'), list())).toBe(false);
    // …and it still opens, because it is the pool again and she is about to pull it.
    expect(matches(heldFor('sara', 25), read())).toBe(true);
  });

  it('does not show the plain pool, nor an order a colleague merely holds', () => {
    expect(matches({ ...base }, list())).toBe(false);
    expect(matches({ ...base, claimedById: 'sara', currentOwnerId: 'sara', signatureStatus: 'SIGNED' }, list())).toBe(false);
    expect(matches(heldFor('sara', 1, 'ACTIVE', { claimedById: 'sara', signatureStatus: 'SIGNED' }), list())).toBe(false);
  });

  it('does not show an order that came back to the queue after a release, even with a fresh time on it', () => {
    expect(matches(heldFor('sara', 1, 'ACTIVE', { confirmationStatus: 'IN_PROGRESS' }), list())).toBe(false);
  });
});

describe('the scopes that never saw the pool still do not', () => {
  it('OWN (a moderator) is untouched: an order held for a colleague is not in her list', () => {
    expect(matches(heldFor('sara', 1), orderListWhere(agent('OWN')))).toBe(false);
  });

  it('ALL_COMPANY sees everything as it always did', () => {
    expect(matches(heldFor('sara', 1), orderListWhere(agent('ALL_COMPANY')))).toBe(true);
  });
});
