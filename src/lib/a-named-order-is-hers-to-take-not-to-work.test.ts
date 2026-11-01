import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — a name on an unclaimed order is not a licence to work it
 *
 * A returning customer's order is named for the agent who worked him last (order-reservation.ts). `assignedToId` has always meant
 * «mine to work», so without this the NAME alone would let her edit, lock, confirm and log calls on an order she had not pulled —
 * past the caps and past the rule that she rings the customer first.
 *
 *  1. Named for her and nobody holds it (NEW, unclaimed): the write doors — `authorize` and the work door — do NOT count it as hers.
 *  2. The moment she holds it (claim, pull, a transfer to her), or it is no longer the NEW order, it is hers exactly as before.
 *  3. A colleague still does not reach it for writing, as before.
 *  4. The READ path is unchanged: she can open it and claim it (the claim door reads through the old door).
 *
 * These use the REAL `authorize` and the REAL work door with real grants — only the database is faked.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({ db: { order: { findUnique: vi.fn() } } }));
vi.mock('./db', () => ({ db, default: db }));

import { attachGrants, authorize } from './authorization';
import { assertOrderAccess } from './rbac';
import { ORDER_WORK_DOOR } from './order-work-door';
import { isHeldRow } from './order-reservation';

const agent = (id: string): SessionUser =>
  attachGrants(
    { id, status: 'ACTIVE', role: 'CONFIRMATION_AGENT', companyId: 'c1', permissions: [] } as unknown as SessionUser,
    {
      fullAccess: false,
      grants: {
        'orders.view': { scope: 'ASSIGNED' },
        'orders.edit': { scope: 'ASSIGNED' },
        'orders.confirm': { scope: 'ASSIGNED' },
        'orders.change_status': { scope: 'ASSIGNED' },
        'confirmation.work': { scope: 'ALL_COMPANY' },
      },
    } as never
  );

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 's1', confirmationStatus: 'NEW', claimedById: null, currentOwnerId: null, moderatorId: null,
  assignedToId: 'sara', assignedAt: new Date(), ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('an order named for her that nobody holds', () => {
  it('is not hers to write by `authorize` — edit, confirm, status', () => {
    for (const permission of ['orders.edit', 'orders.confirm', 'orders.change_status']) {
      const verdict = authorize(agent('sara'), permission, order());
      expect(verdict.allowed, permission).toBe(false);
      expect(verdict.reason).toBe('OUT_OF_SCOPE');
    }
  });

  it('is not hers to work through the work door either (the lock, the call log, the confirmation all use it)', async () => {
    db.order.findUnique.mockResolvedValue(order());
    const access = await assertOrderAccess('o1', agent('sara'), { companyId: 'c1', storeId: 's1' }, ORDER_WORK_DOOR);
    expect(access).toEqual({ allowed: false, reason: 'NOT_ASSIGNED' });
  });

  it('but she can open it and take it: the read door and the claim door read through the old path', async () => {
    db.order.findUnique.mockResolvedValue(order());
    const access = await assertOrderAccess('o1', agent('sara'), { companyId: 'c1', storeId: 's1' });
    expect(access.allowed).toBe(true);
  });

  it('is hers the moment she holds it — claimed, pulled, or transferred to her (both columns written)', async () => {
    const held = order({ claimedById: 'sara', currentOwnerId: 'sara' });
    expect(authorize(agent('sara'), 'orders.edit', held).allowed).toBe(true);
    db.order.findUnique.mockResolvedValue(held);
    expect((await assertOrderAccess('o1', agent('sara'), { companyId: 'c1', storeId: 's1' }, ORDER_WORK_DOOR)).allowed).toBe(true);
  });

  it('is hers as before when it is not the order that just arrived (a legacy assignment on a confirmed order)', () => {
    expect(authorize(agent('sara'), 'orders.edit', order({ confirmationStatus: 'CONFIRMED' })).allowed).toBe(true);
  });

  it('is still no colleague’s to write', () => {
    expect(authorize(agent('huda'), 'orders.edit', order()).allowed).toBe(false);
    expect(authorize(agent('huda'), 'orders.edit', order({ claimedById: 'sara', currentOwnerId: 'sara' })).allowed).toBe(false);
  });

  it('is not hers to work a day later either — the name is not a way to edit an order nobody holds', () => {
    const dayLater = order({ assignedAt: new Date(Date.now() - 30 * 3_600_000) });
    expect(authorize(agent('sara'), 'orders.edit', dayLater).allowed).toBe(false);
  });
});

describe('isHeldRow', () => {
  it.each([
    [{ confirmationStatus: 'NEW', claimedById: null, assignedToId: 'a' }, true],
    [{ confirmationStatus: 'NEW', claimedById: 'a', assignedToId: 'a' }, false],
    [{ confirmationStatus: 'NEW', claimedById: null, assignedToId: null }, false],
    [{ confirmationStatus: 'IN_PROGRESS', claimedById: null, assignedToId: 'a' }, false],
    [{ claimedById: null, assignedToId: 'a' }, false],
  ])('%j → %s', (row, held) => {
    expect(isHeldRow(row)).toBe(held);
  });
});
