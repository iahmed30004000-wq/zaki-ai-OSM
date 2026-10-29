import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER FORM'S OWN DOOR (perm-plan PR-6): the channel names for whoever may type an order, and the moderators' NAMES
 * for whoever may hand orders out — and nothing of anybody's money.
 *
 * The form used to fill its pickers from `/api/moderators` (behind `users.view`, carrying each moderator's sales and
 * commission) and `/api/settings/channels` (a settings route). This door answers exactly what the form needs. Through the
 * REAL engine: a person is built from role rows, and the route asks the real `can`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, current } = vi.hoisted(() => ({
  db: { orderChannel: { findMany: vi.fn() }, user: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  current: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET } from './route';

async function person(keys: string[]): Promise<SessionUser> {
  const base = { id: 'u1', email: 'u@x', name: 'سارة', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orderChannel.findMany.mockResolvedValue([{ id: 'ch1', name: 'فيسبوك' }]);
  db.user.findMany.mockResolvedValue([{ id: 'm1', name: 'ريم' }]);
});

async function ask(keys: string[]) {
  current.user = await person(keys);
  requireContext.mockResolvedValue({ user: current.user, companyId: 'c1', storeId: 's1' });
  const res = await GET();
  return { res, body: await res.json() };
}

describe('GET /api/orders/form-options', () => {
  it('a person who types orders gets the active channels and NO moderators — the picker is not drawn for her', async () => {
    const { res, body } = await ask(['orders.create']);
    expect(res.status).toBe(200);
    expect(body.channels).toEqual([{ id: 'ch1', name: 'فيسبوك' }]);
    expect(body.mayAssign).toBe(false);
    expect(body.moderators).toEqual([]);
    expect(db.user.findMany, 'قُرئ المودريتورز لمن لا يسند').not.toHaveBeenCalled();
  });

  it('a person who hands orders out also gets the moderators — id and name, nothing else', async () => {
    const { body } = await ask(['orders.create', 'orders.assign']);
    expect(body.mayAssign).toBe(true);
    expect(body.moderators).toEqual([{ id: 'm1', name: 'ريم' }]);
    // the query selects only the two columns and only active moderators of THIS company
    const q = db.user.findMany.mock.calls[0][0];
    expect(q.select).toEqual({ id: true, name: true });
    expect(q.where).toEqual({ companyId: 'c1', role: 'MODERATOR', status: 'ACTIVE' });
    expect(JSON.stringify(body)).not.toMatch(/commission|sales|rate/i);
  });

  it('only the active channels of this company are asked for', async () => {
    await ask(['orders.create']);
    expect(db.orderChannel.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', isActive: true });
  });

  it('NEGATIVE: orders.assign alone is not the door — the form is for who may type an order', async () => {
    current.user = await person(['orders.assign', 'orders.view']);
    requireContext.mockResolvedValue({ user: current.user, companyId: 'c1', storeId: 's1' });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(db.orderChannel.findMany).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
