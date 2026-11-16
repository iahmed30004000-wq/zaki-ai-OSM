import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NO NIGHT SHIFT FOR AN EMPLOYEE EITHER (the planner 16/11, ruling 41 — the country's own rule, 18, applied to a person).
 *
 * A start at or after the hand-over time is refused with an Arabic message and nothing is written. The route already did it for
 * the pair the shift card posts; this pins it, so a later edit cannot quietly allow an overnight shift (lateness and the
 * deduction are counted from these two times).
 */

const { db } = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    role: { findFirst: vi.fn(), findUnique: vi.fn() },
    company: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(), resolveSingleCompanyId: async () => 'c1' }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => ({ id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' }),
  can: () => true,
}));
vi.mock('@/lib/user-permissions', () => ({
  canConferRole: async () => ({ ok: true }),
  canActOnUser: async () => ({ ok: true }),
}));

import { PATCH } from './route';

const row = (id: string) => ({
  id, name: 'سارة', email: 's@x.com', role: 'CONFIRMATION_AGENT', roleId: 'role-agent', status: 'ACTIVE',
  companyId: 'c1', phone: '0911222333', shiftStart: '09:00', shiftEnd: '17:00', restDays: '5', assignedBy: null,
});

const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'u2' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => row(where.id));
  db.user.update.mockImplementation(async () => row('u2'));
});

describe('an employee shift that ends before it starts', () => {
  it.each([
    ['overnight', { shiftStart: '22:00', shiftEnd: '06:00' }],
    ['the same minute', { shiftStart: '10:00', shiftEnd: '10:00' }],
    ['one minute back', { shiftStart: '10:01', shiftEnd: '10:00' }],
  ])('is refused with an Arabic message and nothing is written: %s', async (_n, shift) => {
    const res = await patch({ action: 'updateContact', ...shift });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('وقت التسليم يجب أن يكون بعد وقت البدء');
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('a normal day still saves', async () => {
    const res = await patch({ action: 'updateContact', shiftStart: '10:00', shiftEnd: '22:00' });
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ shiftStart: '10:00', shiftEnd: '22:00' });
  });
});
