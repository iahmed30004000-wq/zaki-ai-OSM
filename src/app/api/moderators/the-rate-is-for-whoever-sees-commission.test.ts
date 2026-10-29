import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE LIST FILLS THE «المودريتور» BOX — IT DOES NOT HAND OUT WHAT EACH ONE EARNS (RV161).
 *
 * `GET /api/moderators` opens on «عرض المستخدمين». The new-order window calls it for names, and it answered every
 * reader with each moderator's commission RATE and running commission total. Both are shown on the commission screen
 * to whoever holds `commission.view`, so that existing key is what opens them here. No new key.
 */

const { db, requireCompanyTenant, requirePermission, can } = vi.hoisted(() => ({
  db: { user: { findMany: vi.fn() } },
  requireCompanyTenant: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: (...a: unknown[]) => requireCompanyTenant(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/commission', () => ({ commissionByUserForOrders: vi.fn(async () => new Map([['m1', 123.456]])) }));

import { GET } from './route';

const VIEWER = { id: 'viewer', status: 'ACTIVE' };

beforeEach(() => {
  vi.clearAllMocks();
  requireCompanyTenant.mockResolvedValue({ user: VIEWER, companyId: 'c1' });
  requirePermission.mockResolvedValue(VIEWER);
  db.user.findMany.mockResolvedValue([
    {
      id: 'm1', name: 'سارة', email: 's@x.com', phone: '0911', status: 'ACTIVE', commissionRate: 7.5,
      assignedOrders: [
        { id: 'o1', orderNumber: 'N1', confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED', totalAmount: 100, collectedAmount: 100, createdAt: new Date() },
      ],
    },
  ]);
});

describe('what a moderator earns', () => {
  it('is withheld from a reader without the commission key — rate and total both', async () => {
    can.mockReturnValue(false);
    const { moderators } = await (await GET()).json();
    expect(moderators).toHaveLength(1);
    expect(moderators[0]).not.toHaveProperty('commissionRate');
    expect(moderators[0].stats).not.toHaveProperty('commissions');
    expect(JSON.stringify(moderators)).not.toContain('7.5');
    expect(JSON.stringify(moderators)).not.toContain('123.46');
  });

  it('and the box still has what it needs: the name, the id, the work counts', async () => {
    can.mockReturnValue(false);
    const [m] = (await (await GET()).json()).moderators;
    expect(m).toMatchObject({ id: 'm1', name: 'سارة', status: 'ACTIVE' });
    expect(m.stats).toMatchObject({ totalOrders: 1, confirmedOrders: 1, deliveredOrders: 1 });
  });

  it('is shown to a reader who holds the commission key, as it always was', async () => {
    can.mockReturnValue(true);
    const [m] = (await (await GET()).json()).moderators;
    expect(m.commissionRate).toBe(7.5);
    expect(m.stats.commissions).toBe(123.46);
  });

  it('asks for the EXISTING key, by name', async () => {
    can.mockReturnValue(false);
    await GET();
    expect(can).toHaveBeenCalledWith(VIEWER, 'commission.view');
  });

  it('and the list door itself is still «عرض المستخدمين»', async () => {
    can.mockReturnValue(false);
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('users.view');
  });
});
